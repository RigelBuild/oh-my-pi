{
  pkgs,
  bun,
  bun2nix,
  rustToolchain,
}:
let
  inherit (pkgs) lib;
  hk =
    if
      builtins.elem pkgs.stdenv.hostPlatform.system [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ]
    then
      import ./hk.nix { inherit pkgs; }
    else
      null;
  linuxLibraries = with pkgs; [
    libpulseaudio
    pipewire
    stdenv.cc.cc.lib
    zlib
  ];
in
pkgs.mkShell (
  {
    name = "omp-dev";

    packages =
      [ bun bun2nix rustToolchain ]
      ++ (with pkgs; [
        cargo-nextest
        rustPlatform.bindgenHook
        nixfmt
        typescript-language-server

        python312
        python312Packages.pip
        uv
        basedpyright

        bash
        cacert
        curl
        fd
        git
        git-lfs
        imagemagick
        openssh
        ripgrep
        sqlite
        unzip

        cmake
        ninja
        pkg-config
        zig

        cairo
        giflib
        libjpeg
        librsvg
        openssl
        pango
        pcre2
        zlib
      ])
      ++ lib.optional (hk != null) hk
      ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux linuxLibraries;

    PCRE2_SYS_STATIC = "1";
    RUST_SRC_PATH = "${rustToolchain}/lib/rustlib/src/rust/library";
  }
  // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
    LD_LIBRARY_PATH = lib.makeLibraryPath linuxLibraries;
  }
)
