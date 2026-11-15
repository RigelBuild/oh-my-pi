{
  version = "18.18.3-rigel.4";
  assets = {
    x86_64-linux = {
      name = "omp-linux-x64";
      hash = "sha256-Eg3vCp3AW71LYwi651DRIhDzf9Xpto3RajLncMHCGtY=";
    };
    aarch64-linux = {
      name = "omp-linux-arm64";
      hash = "sha256-kRIpknHknnHmdyiOuJmwg8KbNayC7HNpmxfkaveyvlo=";
    };
    aarch64-darwin = {
      name = "omp-darwin-arm64";
      hash = "sha256-RWnvs62bgL4cVnAgcwPRsbC5KUx78hCzlmuTFQ0Iv/4=";
    };
    x86_64-darwin = {
      name = "omp-darwin-x64";
      hash = "sha256-JbbrcTGaQCqyxVTJpDpZu+/VKDAnRpP/75tB/LMvOfI=";
    };
  };
}
