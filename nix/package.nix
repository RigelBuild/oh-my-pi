{
  addDriverRunpath,
  autoPatchelfHook,
  alsa-lib,
  apple-sdk_27 ? null,
  bun,
  bun2nix,
  callPackage,
  config,
  craneLib,
  cudaPackages_13 ? null,
  darwin,
  lib,
  libpulseaudio,
  makeBinaryWrapper,
  pipewire,
  removeReferencesTo,
  source,
  stdenv,
  # onnxruntime-node (downloaded into the agent cache on first use) ships CUDA
  # execution providers that dlopen vendor libraries absent from the NixOS
  # loader path. Enabling this appends them to the inference workers'
  # LD_LIBRARY_PATH so the GPU provider loads instead of quietly degrading to
  # CPU. Mirrors nixpkgs' `cudaSupport` convention (sunshine, obs-studio,
  # btop). Note the closure cost — libcublas ~745 MB, libcurand ~136 MB,
  # cuda_cudart ~74 MB — so this stays opt-in and off by default.
  cudaSupport ? config.cudaSupport,
  # Wayland screencast loads libpipewire at runtime; this puts it on the addon's
  # RUNPATH, whose runtime closure adds ~750 MB (gstreamer, ffmpeg, systemd,
  # ...). Default to the lean build; opt in via `.override`.
  withWaylandScreencast ? false,
  # Downstream callers can opt out of the Swift/SDK dependency. The official
  # Apple Silicon package must include the bridge by default.
  withAppleFm ? stdenv.hostPlatform.system == "aarch64-darwin",
  # Release builds use fat LTO with one codegen unit, which is slow. Set this
  # to false for faster local builds with thin LTO and 16 codegen units.
  withFatLto ? true,
}:
let
  packageJson = lib.importJSON ../packages/coding-agent/package.json;
  rootPackageJson = lib.importJSON ../package.json;
  nativeBuild = callPackage ./native.nix {
    inherit
      source
      craneLib
      withFatLto
      withAppleFm
      apple-sdk_27
      ;
  };
  inherit (nativeBuild) platform;
  bunRuntimeTemplate = callPackage ./bun-runtime.nix { inherit bun; };
  patchedDependencies = lib.mapAttrs (
    _: patch: source + "/${patch}"
  ) rootPackageJson.patchedDependencies;
  patchOverrides = bun2nix.patchedDependenciesToOverrides { inherit patchedDependencies; };
  runtimeNativeLibraries = import ./runtime-native-libraries.nix {
    inherit
      addDriverRunpath
      cudaPackages_13
      cudaSupport
      lib
      stdenv
      ;
  };
  linuxLoaderFixup = import ./linux-loader-fixup.nix {
    inherit
      bun
      cudaPackages_13
      cudaSupport
      lib
      runtimeNativeLibraries
      stdenv
      ;
  };
in
stdenv.mkDerivation {
  pname = "omp";
  inherit (packageJson) version;
  src = source;

  passthru = { inherit nativeBuild; };
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
    overrides = patchOverrides;
  };

  nativeBuildInputs = [
    bun
    bun2nix.hook
    removeReferencesTo
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    autoPatchelfHook
    makeBinaryWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [ darwin.autoSignDarwinBinariesHook ];

  # libgcc_s is resolved from the compiler's lib output during autoPatchelf.
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];

  strictDeps = true;
  # Nix builders cannot reliably hardlink cache files into node_modules
  # (and Darwin's clonefile backend also rejects store permissions).
  bunInstallFlags = [
    "--linker=isolated"
    "--backend=copyfile"
  ];
  dontConfigure = true;
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  dontStrip = true;

  env = {
    SOURCE_DATE_EPOCH = "1";
  }
  // lib.optionalAttrs stdenv.hostPlatform.isDarwin { BUN_NO_CODESIGN_MACHO_BINARY = "1"; };

  buildPhase = ''
    runHook preBuild

    echo "Preparing pi-natives"
    install -Dm755 "${nativeBuild}/lib/${platform.nativeLibrary}" \
      "packages/natives/native/${platform.addon}"
    # The loader and embed-native.ts require the release version, which is
    # written into the addon after linking (build-bindings.ts does this for
    # local builds; this raw cargo build must do it itself). Darwin re-signs
    # through signIfRequired below; the sandbox has no system codesign.
    bun scripts/stamp-native-version.ts --no-sign \
      "packages/natives/native/${platform.addon}"
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      # The loader extracts this archived addon at runtime, so fix its
      # interpreter-independent Nix RPATH before Bun embeds it.
      autoPatchelf -- "packages/natives/native/${platform.addon}"
      # pi-voice dlopens libpulse-simple.so.0 / libpulse.so.0 / libasound.so.2,
      # and Wayland capture libpipewire-0.3.so.0, by bare name; glibc resolves
      # those through the calling object's RUNPATH, so append the client
      # libraries here. Nothing links them, so autoPatchelf cannot discover
      # them on its own.
      patchelf --add-rpath "${
        lib.makeLibraryPath (
          [
            libpulseaudio
            alsa-lib
          ]
          ++ lib.optional withWaylandScreencast pipewire
        )
      }" \
        "packages/natives/native/${platform.addon}"
    ''}
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      # The darwin stdenv links C code against darwin.libiconv, whose install
      # name is an absolute /nix/store path. The addon is gzip-embedded in the
      # bun binary, so that reference is invisible to the output scanner and the
      # library is absent from the runtime closure on target machines. Repoint
      # it at the system libiconv (dyld shared cache, same ABI).
      install_name_tool -change "${darwin.libiconv}/lib/libiconv.2.dylib" \
        /usr/lib/libiconv.2.dylib "packages/natives/native/${platform.addon}"
      # arm64 Darwin requires even locally-built Mach-O addons to carry an
      # ad-hoc signature. The install-name rewrite invalidates it, so sign
      # after the change and before Bun archives the file.
      signIfRequired "packages/natives/native/${platform.addon}"
    ''}

    echo "Compiling OMP"
    BUN_COMPILE_EXECUTABLE_PATH="${bunRuntimeTemplate}/libexec/bun" \
      bun --cwd="$PWD/packages/coding-agent" run build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 packages/coding-agent/dist/omp "$out/bin/omp"
    install -Dm644 LICENSE "$out/share/doc/omp/LICENSE"
    # The executable embeds the CLI and the native addon; ship both notices.
    {
      cat packages/coding-agent/THIRD-PARTY-NOTICES.txt
      echo
      cat packages/natives/THIRD-PARTY-NOTICES.txt
    } > "$out/share/doc/omp/THIRD-PARTY-NOTICES.txt"

    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      # The addon is gzip-compressed inside the compiled binary, so its linked
      # store paths are invisible to the output reference scanner.
      mkdir -p "$out/nix-support"
      patchelf --print-rpath "packages/natives/native/${platform.addon}" \
        > "$out/nix-support/embedded-addon-runpath"
    ''}

    runHook postInstall
  '';

  # Bun serializes the build interpreter path into the bundled entrypoint's
  # inert shebang. Remove its hash before Nix scans output references; this
  # runs before Darwin's binary-signing fixup hook.
  preFixup = ''
    remove-references-to -t ${bun} "$out/bin/omp"
  '';

  # The shared hook patches DT_NEEDED and repairs DT_VERDEF on Linux.
  inherit (linuxLoaderFixup) postFixup preInstallCheck;

  disallowedReferences = [ bun ];

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    # Capture rather than pipe: with pipefail, grep could hide omp's #9881 loader SIGSEGV.
    smokeOutput="$(HOME="$TMPDIR" "$out/bin/omp" --smoke-test)"
    grep -q "smoke-test: ok" <<<"$smokeOutput"
    BUN_BE_BUN=1 "$out/bin/omp" -e \
      'if (Bun.version !== "${bun.version}" || typeof Bun.Image !== "function") process.exit(1)'
    ${linuxLoaderFixup.installCheck}
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      # Darwin release_smoke verifies signatures; keep the local addon path check.
      addonDeps="$(otool -L "packages/natives/native/${platform.addon}")"
      if grep -q "/nix/store/" <<<"$addonDeps"; then
        echo "embedded addon references /nix/store paths:" >&2
        echo "$addonDeps" >&2
        exit 1
      fi
      # Linking against a newer SDK (apple-sdk_27 for the Foundation Models
      # bridge) must not raise the addon's minimum macOS above the platform
      # floor; only the embedded bridge targets macOS 27.
      addonLoadCommands="$(otool -l "packages/natives/native/${platform.addon}")"
      addonMinos="$(awk '$1 == "cmd" { build = $2 == "LC_BUILD_VERSION" } build && $1 == "minos" { print $2; exit }' <<<"$addonLoadCommands")"
      darwinFloor=${stdenv.hostPlatform.darwinMinVersion}
      if [ -z "$addonMinos" ] || [ "$(printf '%s\n' "$addonMinos" "$darwinFloor" | sort -V | tail -n 1)" != "$darwinFloor" ]; then
        echo "embedded addon requires macOS ''${addonMinos:-unknown}, above the platform floor $darwinFloor" >&2
        exit 1
      fi
    ''}
    ${lib.optionalString withAppleFm ''
      # Model/device eligibility is not a build requirement. On macOS 27+,
      # this exercises materialization/dlopen. On older macOS, unsupported_os
      # only proves the embedded bridge is non-empty; it is not loaded.
      HOME="$TMPDIR" bun -e '
        const native = require("./packages/natives/native/${platform.addon}");
        const status = JSON.parse(await native.appleFmAvailability());
        console.log("Apple Foundation Models:", status);
        const eligibilityReasons = [
          "unsupported_os",
          "device_not_eligible",
          "apple_intelligence_not_enabled",
          "model_not_ready",
          "unavailable",
        ];
        if (
          status?.type !== "availability" ||
          !(status.available === true ||
            (status.available === false && eligibilityReasons.includes(status.reason)))
        ) process.exit(1);
      '
    ''}
    runHook postInstallCheck
  '';

  meta = {
    description = "Terminal-based coding agent with multi-model support";
    homepage = "https://omp.sh";
    changelog = "https://github.com/can1357/oh-my-pi/releases/tag/v${packageJson.version}";
    license = lib.licenses.mit;
    mainProgram = "omp";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    sourceProvenance = with lib.sourceTypes; [
      binaryNativeCode
      fromSource
    ];
  };
}
