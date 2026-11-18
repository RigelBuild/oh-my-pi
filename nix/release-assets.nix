{
  version = "18.18.3-rigel.11";
  assets = {
    x86_64-linux = {
      name = "omp-linux-x64";
      hash = "sha256-mizZ/FjLFgvTpNx3wbgCY+wuXcQIXaC4yk8/T1Lbn0g=";
    };
    aarch64-linux = {
      name = "omp-linux-arm64";
      hash = "sha256-aXDqZFsDBg0p2DTPCWdo6v89RFxNdGqVE5vjr4VVQj4=";
    };
    aarch64-darwin = {
      name = "omp-darwin-arm64";
      hash = "sha256-keybFpTBM8LJAIaw05Xeuy37yIfLdUJp9xA8iZVesaE=";
    };
    x86_64-darwin = {
      name = "omp-darwin-x64";
      hash = "sha256-OlY8oglD1x3ewvonAUmluePTCqFQoblSiMglIE4hYnM=";
    };
  };
}
