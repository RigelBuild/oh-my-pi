{
  version = "18.9.2-rigel.2";
  assets = {
    x86_64-linux = {
      name = "omp-linux-x64";
      hash = "sha256-q2VODOOK8WiODDC3Pbh7wyQcsfSTcw2Zz+36toHBCKw=";
    };
    aarch64-linux = {
      name = "omp-linux-arm64";
      hash = "sha256-tbhRb2tOfb1QZEaRV8W92NsWwii782OeCt6YwC05VdU=";
    };
    aarch64-darwin = {
      name = "omp-darwin-arm64";
      hash = "sha256-DXaHTpiNponLaRJGWHjnprL8yy4jlokRZcD84mVlIGU=";
    };
    x86_64-darwin = {
      name = "omp-darwin-x64";
      hash = "sha256-4joWy2LwYsmWSPHKsO8tGj0oy2DRAnN/r3xT+T85DR4=";
    };
  };
}
