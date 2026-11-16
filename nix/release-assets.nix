{
  version = "18.18.3-rigel.5";
  assets = {
    x86_64-linux = {
      name = "omp-linux-x64";
      hash = "sha256-nzh1cRzKOLLoE7xre88wwP8YHKMPKPxz1ZeZ36nbf2U=";
    };
    aarch64-linux = {
      name = "omp-linux-arm64";
      hash = "sha256-zSwnDbxAkpRXHdRJdFyjMhdn/AF2W0bmrhMErjgcvI0=";
    };
    aarch64-darwin = {
      name = "omp-darwin-arm64";
      hash = "sha256-S70RelUWJJZ8LawACW1g9vcU6NcfoZxeHp9nYOlxD/0=";
    };
    x86_64-darwin = {
      name = "omp-darwin-x64";
      hash = "sha256-kq6wmaKla/fqmWXvHcpU1ZhuDyJR7E8XExpxAu6D2gg=";
    };
  };
}
