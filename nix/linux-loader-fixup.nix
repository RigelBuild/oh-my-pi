{
  bun,
  cudaPackages_13 ? null,
  cudaSupport,
  lib,
  runtimeLDLibraryPath ? [ ],
  runtimeNativeLibraries,
  stdenv,
}:
let
  isLinux = stdenv.hostPlatform.isLinux;
  cudaEnabled = cudaSupport && isLinux && cudaPackages_13 != null;
in
{
  # Keep the preloaded C++ runtime available to dlopen'd addons.
  postFixup = lib.optionalString isLinux ''
    patchelf --add-needed libstdc++.so.6 "$out/bin/omp"
    wrapProgram "$out/bin/omp" \
      --set-default OMP_NATIVE_LIBRARY_PATH "${lib.makeLibraryPath runtimeNativeLibraries}" \
      ${lib.optionalString (runtimeLDLibraryPath != [ ]) ''
        --prefix LD_LIBRARY_PATH : "${lib.makeLibraryPath runtimeLDLibraryPath}"
      ''}
  '';

  preInstallCheck = lib.optionalString isLinux ''
    bun ${../scripts/fix-dt-verdef.ts} "$out/bin/.omp-wrapped"
  '';

  installCheck = lib.optionalString isLinux ''
    # Prove the advertised paths resolve dlopen dependencies.
    env -u LD_LIBRARY_PATH BUN_BE_BUN=1 "$out/bin/omp" -e \
      'const {dlopen}=require("bun:ffi");const dirs=(process.env.OMP_NATIVE_LIBRARY_PATH||"").split(":").filter(Boolean);const need={"libstdc++.so.6":{__cxa_demangle:{args:["ptr","ptr","ptr","ptr"],returns:"ptr"}},"libgcc_s.so.1":{_Unwind_Backtrace:{args:["ptr","ptr"],returns:"i32"}}};for(const lib of Object.keys(need)){let ok=false;for(const d of dirs){try{dlopen(d+"/"+lib,need[lib]);ok=true;break}catch(e){}}if(!ok){console.error("unresolved: "+lib);process.exit(1)}}'
    patchelf --print-needed "$out/bin/.omp-wrapped" | grep -q '^libstdc++\.so\.6$'
    ${lib.optionalString (runtimeLDLibraryPath != [ ]) ''
      env -u LD_LIBRARY_PATH BUN_BE_BUN=1 "$out/bin/omp" -e \
        'const {dlopen}=require("bun:ffi");const need={"libpulse-simple.so.0":{pa_simple_free:{args:["ptr"],returns:"void"}},"libpulse.so.0":{pa_strerror:{args:["i32"],returns:"ptr"}},"libasound.so.2":{snd_strerror:{args:["i32"],returns:"ptr"}}};for(const [lib,syms] of Object.entries(need)){try{dlopen(lib,syms).close()}catch(e){console.error("unresolved: "+lib);process.exit(1)}}'
    ''}
  '' + lib.optionalString cudaEnabled ''
    # Require the CUDA 13 provider sonames used by onnxruntime-node to resolve.
    env -u LD_LIBRARY_PATH BUN_BE_BUN=1 "$out/bin/omp" -e \
      'const {dlopen}=require("bun:ffi");const dirs=(process.env.OMP_NATIVE_LIBRARY_PATH||"").split(":").filter(Boolean);const need={"libcublasLt.so.13":{cublasLtGetVersion:{args:[],returns:"ptr"}},"libcublas.so.13":{cublasGetVersion:{args:[],returns:"ptr"}},"libcurand.so.10":{curandGetVersion:{args:["ptr"],returns:"i32"}},"libcudart.so.13":{cudaRuntimeGetVersion:{args:["ptr"],returns:"i32"}}};for(const lib of Object.keys(need)){let ok=false;for(const d of dirs){try{dlopen(d+"/"+lib,need[lib]);ok=true;break}catch(e){}}if(!ok){console.error("unresolved: "+lib);process.exit(1)}}'
  '';
}
