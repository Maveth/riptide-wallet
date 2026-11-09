#!/usr/bin/env bash
# Regenerate the REST specification and Rust client from the current API.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
if [[ -n "${OPENAPI_GENERATOR_JAR:-}" ]]; then
  generator=(java -jar "$OPENAPI_GENERATOR_JAR")
else
  generator=(openapi-generator-cli)
fi
[[ "$("${generator[@]}" version)" == '7.22.0' ]] || {
  echo 'Use OpenAPI Generator 7.22.0 to match the committed client.' >&2
  exit 1
}
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
cargo run --locked --quiet -p bark-rest --example dump_api_docs > "$stage/openapi.json"
version=$(sed -nE 's/^version = "([^"]+)"/\1/p' bark-rest/Cargo.toml | head -1)
"${generator[@]}" generate -i "$stage/openapi.json" -g rust -o "$stage/client" \
  --package-name bark-rest-client --artifact-version "$version" \
  --additional-properties "packageVersion=$version" \
  --additional-properties 'reqwestDefaultFeatures=rustls'
python3 - "$root" "$stage" "$version" <<'PY'
from pathlib import Path
import shutil
import sys
root, stage = map(Path, sys.argv[1:3])
version = sys.argv[3]
client = stage/'client'
cargo = client/'Cargo.toml'
text = cargo.read_text()
assert '[dependencies]' in text and '[features]' in text
text = text.replace('[dependencies]', '[dependencies]\n'
    f'bark-json = {{ version = "{version}", path = "../bark-json" }}\n'
    f'bark-rest = {{ version = "{version}", path = "../bark-rest", default-features = false }}', 1)
text = text.replace('[features]', '[features]\nrustls-no-provider = ["reqwest/rustls-no-provider"]', 1)
cargo.write_text(text)
shutil.rmtree(client/'src/models')
(client/'src/models').mkdir()
shutil.copyfile(root/'bark-rest/helpers/models.rs', client/'src/models/mod.rs')
# Normalize generator whitespace so the result passes the repository diff checks.
for path in client.rglob('*'):
    if path.is_file():
        data = path.read_text()
        path.write_text('\n'.join(line.rstrip() for line in data.splitlines()).rstrip()+'\n')
target = root/'bark-rest-client'
assert target.resolve().parent == root.resolve() and (root/'Cargo.toml').is_file()
shutil.rmtree(target)
shutil.copytree(client, target)
shutil.copyfile(stage/'openapi.json', root/'bark-rest/openapi.json')
PY
