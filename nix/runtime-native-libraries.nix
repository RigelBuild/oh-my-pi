{
  addDriverRunpath,
  cudaPackages_13 ? null,
  cudaSupport,
  lib,
  stdenv,
}:
let
  # Vendor libraries the on-demand onnxruntime-node CUDA execution provider
  # dlopens. These are not needed for the addon itself to load (postFixup's
  # DT_NEEDED covers libstdc++/libgcc), but the provider is its own .so whose
  # dependencies sit outside the NixOS loader path, so the worker needs them on
  # LD_LIBRARY_PATH to load a GPU provider instead of degrading to CPU.
  #
  # CUDA 13 specifically: the shipped provider's sonames are libcublasLt.so.13 /
  # libcublas.so.13 / libcurand.so.10 / libcudart.so.13. CUDA 12 (nixpkgs'
  # default `cudaPackages`) only provides .so.12, so taking this build's
  # `cudaPackages` would silently fail to resolve them; pin the 13.x series.
  # Verified by dlopen: without these the provider dies on libcublasLt.so.13.
  cudaRuntimeLibraries =
    let
      # The driver itself (libcuda.so.1) is not a redistributable: it only
      # exists at the host's driver link, which is stable across driver
      # upgrades and present exactly when the machine can run CUDA at all.
      driver = addDriverRunpath.driverLink;
      libDirs = lib.concatMap (p: [ (lib.getLib p) ]) [
        cudaPackages_13.libcublas
        cudaPackages_13.libcurand
        cudaPackages_13.cuda_cudart
      ];
    in
    lib.optionals (cudaSupport && stdenv.hostPlatform.isLinux && cudaPackages_13 != null) (
      [ driver ] ++ libDirs
    );
in
lib.optionals stdenv.hostPlatform.isLinux (
  [ stdenv.cc.cc.lib ] ++ lib.optional (stdenv.cc.cc ? libgcc) stdenv.cc.cc.libgcc
)
++ cudaRuntimeLibraries
