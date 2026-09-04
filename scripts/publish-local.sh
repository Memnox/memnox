#!/bin/sh
# Publishes every workspace package in dependency order, skipping any version
# already on the registry so a half-finished run is re-runnable.
#
# Provenance needs CI OIDC, so a laptop run passes --provenance=false and the
# release is unattested. Prefer pushing a tag and letting .github/workflows/release.yml do it.
set -e

VERSION="$(node -p "require('./packages/core/package.json').version")"

mismatched=""
for dir in packages/*/; do
  name="$(node -p "require('./$dir/package.json').name")"
  version="$(node -p "require('./$dir/package.json').version")"
  [ "$version" = "$VERSION" ] || mismatched="$mismatched $name@$version"
done
if [ -n "$mismatched" ]; then
  echo "not every package is at $VERSION:$mismatched" >&2
  exit 1
fi

npm run typecheck
npm test
npm run build

node -e "
  const fs=require('fs');
  const pkgs={};
  for (const d of fs.readdirSync('packages')) {
    const p=JSON.parse(fs.readFileSync('packages/'+d+'/package.json','utf8'));
    if (p.private) continue;
    pkgs[p.name]={deps:Object.keys({...p.dependencies,...p.peerDependencies})
      .filter(k=>k==='memnox'||k.startsWith('@memnox/'))};
  }
  const done=new Set(), order=[];
  while (order.length<Object.keys(pkgs).length){
    const ready=Object.entries(pkgs)
      .filter(([n,v])=>!done.has(n)&&v.deps.every(d=>done.has(d)))
      .map(([n])=>n).sort();
    if(!ready.length){console.error('dependency cycle');process.exit(1);}
    ready.forEach(n=>{done.add(n);order.push(n);});
  }
  console.log(order.join('\n'));
" > publish-order.txt
cat publish-order.txt

while read -r pkg; do
  [ -n "$pkg" ] || continue
  if npm view "$pkg@$VERSION" version >/dev/null 2>&1; then
    echo "skip      $pkg@$VERSION already published"
    continue
  fi
  echo "publish   $pkg@$VERSION"
  npm publish -w "$pkg" --access public --provenance=false
done < publish-order.txt

rm -f publish-order.txt
echo "done — $VERSION is on the registry"
