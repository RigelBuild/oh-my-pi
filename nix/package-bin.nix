{
  addDriverRunpath,
  autoPatchelfHook,
  bun,
  config,
  cudaPackages_13 ? null,
  fetchurl,
  lib,
  makeBinaryWrapper,
  stdenv,
  cudaSupport ? config.cudaSupport,
}:
let
  release = import ./release-assets.nix;
  asset = release.assets.${stdenv.hostPlatform.system};
  runtimeNativeLibraries = import ./runtime-native-libraries.nix {
    inherit addDriverRunpath cudaPackages_13 cudaSupport lib stdenv;
  };
in
stdenv.mkDerivation {
  pname = "omp-bin";
  version = release.version;
  src = fetchurl {
    url = "https://github.com/RigelBuild/oh-my-pi/releases/download/v${release.version}/${asset.name}";
    name = asset.name;
    inherit (asset) hash;
  };

  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ bun autoPatchelfHook makeBinaryWrapper ];
  # libgcc_s is resolved from the compiler's lib output during autoPatchelf.
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;
  # Stripping can invalidate the signed Mach-O release binary and ELF version data.
  dontStrip = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 "$src" "$out/bin/omp"
    runHook postInstall
  '';

  # Keep libstdc++ loaded for direct dlopen; scope advertised libraries to workers, not child commands.
  postFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
    patchelf --add-needed libstdc++.so.6 "$out/bin/omp"
    wrapProgram "$out/bin/omp" \
      --set-default OMP_NATIVE_LIBRARY_PATH "${lib.makeLibraryPath runtimeNativeLibraries}"
  '';

  # patchelf can stale DT_VERDEF as it grows .dynamic, causing glibc to crash before main.
  # Run after the autoPatchelfHook fixup and repair wrapProgram's .omp-wrapped ELF.
  preInstallCheck = lib.optionalString stdenv.hostPlatform.isLinux ''
    bun ${../scripts/fix-dt-verdef.ts} "$out/bin/.omp-wrapped"
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    # Capture output so errexit reports omp's real status and stderr if it crashes.
    versionOutput="$(HOME="$TMPDIR" "$out/bin/omp" --version)"
    test "$versionOutput" = "omp/${release.version}"
    smokeOutput="$(HOME="$TMPDIR" "$out/bin/omp" --smoke-test)"
    grep -q "smoke-test: ok" <<<"$smokeOutput"
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      # Verify the paths advertised to dlopen really resolve both C++ runtimes.
      env -u LD_LIBRARY_PATH BUN_BE_BUN=1 "$out/bin/omp" -e \
        'const {dlopen}=require("bun:ffi");const dirs=(process.env.OMP_NATIVE_LIBRARY_PATH||"").split(":").filter(Boolean);const need={"libstdc++.so.6":{__cxa_demangle:{args:["ptr","ptr","ptr","ptr"],returns:"ptr"}},"libgcc_s.so.1":{_Unwind_Backtrace:{args:["ptr","ptr"],returns:"i32"}}};for(const lib of Object.keys(need)){let ok=false;for(const d of dirs){try{dlopen(d+"/"+lib,need[lib]);ok=true;break}catch(e){}}if(!ok){console.error("unresolved: "+lib);process.exit(1)}}'
      # The libstdc++ preload is required for addons dlopen'd by omp itself.
      patchelf --print-needed "$out/bin/.omp-wrapped" | grep -q '^libstdc++\.so\.6$'
    ''}
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      # Verify rather than re-sign; Darwin fixup tooling would rewrite the release Mach-O.
      codesign --verify --strict "$out/bin/omp"
    ''}
    runHook postInstallCheck
  '';

  meta = {
    description = "Prebuilt OMP coding agent binary";
    homepage = "https://omp.sh";
    license = lib.licenses.mit;
    mainProgram = "omp";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
  };
}
