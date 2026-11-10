{
  addDriverRunpath,
  alsa-lib,
  autoPatchelfHook,
  bun,
  config,
  cudaPackages_13 ? null,
  fetchurl,
  lib,
  libpulseaudio,
  makeBinaryWrapper,
  stdenv,
  cudaSupport ? config.cudaSupport,
}:
let
  release = import ./release-assets.nix;
  asset = release.assets.${stdenv.hostPlatform.system};
  runtimeNativeLibraries = import ./runtime-native-libraries.nix {
    inherit
      addDriverRunpath
      cudaPackages_13
      cudaSupport
      lib
      stdenv
      ;
  };
  preloadLibraries = [
    "libpulse-simple.so.0"
    "libpulse.so.0"
    "libasound.so.2"
  ];
  linuxLoaderFixup = import ./linux-loader-fixup.nix {
    inherit
      bun
      cudaPackages_13
      cudaSupport
      lib
      preloadLibraries
      runtimeNativeLibraries
      stdenv
      ;
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

  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    bun
    autoPatchelfHook
    makeBinaryWrapper
  ];
  # libgcc_s is resolved from the compiler's lib output during autoPatchelf.
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib
    libpulseaudio
    alsa-lib
  ];
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

  inherit (linuxLoaderFixup) postFixup preInstallCheck;

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    versionOutput="$(HOME="$TMPDIR" "$out/bin/omp" --version)"
    test "$versionOutput" = "omp/${release.version}"
    # Capture rather than pipe: with pipefail, grep could hide omp's #9881 loader SIGSEGV.
    smokeOutput="$(HOME="$TMPDIR" "$out/bin/omp" --smoke-test)"
    grep -q "smoke-test: ok" <<<"$smokeOutput"
    ${linuxLoaderFixup.installCheck}
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
