{
  version = "18.22.2-rigel.1";
  assets = {
    x86_64-linux = {
      name = "omp-linux-x64";
      hash = "sha256-ZZJVAnU9Go8bV9+HjFwZCugYBiP9oq9j3yRdWwY9HUo=";
    };
    aarch64-linux = {
      name = "omp-linux-arm64";
      hash = "sha256-aqKuJBSHP8dDWCI950L9DNCvOmtw3p+tlgf0PI0Yc9Y=";
    };
    aarch64-darwin = {
      name = "omp-darwin-arm64";
      hash = "sha256-sLsJ11IaftweqkqrcVGwL4brcteftoioO/pDk8fwlM8=";
    };
    x86_64-darwin = {
      name = "omp-darwin-x64";
      hash = "sha256-yaeV9j1pxO49whX9GbDaIIwya2zjnNRWl6qZnoEZiC0=";
    };
  };
}
