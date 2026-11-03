#!/bin/sh
# Instalador do "CarPlay map -> cluster" para iDrive7 MGU (CarPlay 0.20.20).
# Roda NO carro, como root. Monta o pacote mgu-deploy do produtor (com o
# cluster_render_client.js que VEM do cluster-render do robertn) e instala o
# produtor + o app de liga/desliga.
#
# Uso (no carro):
#   ./install/install.sh [/caminho/para/cluster_render_client.js]
# Se nao passar o caminho, procura em producer/cluster_render_client.js.
set -e

HERE=$(cd "$(dirname "$0")/.." && pwd)        # raiz do repo (install.sh esta em install/)
PRODUCER="$HERE/producer/carplay-map-cluster.js"
PKG="$HERE/packages/carplay-map-tool"
APP_TGZ="$HERE/app/carplay_map_toggle/carplay_map_toggle.src.tgz"
MD=/var/opt/mgu-deploy/mgu-deploy.sh
CLIENT="${1:-$HERE/producer/cluster_render_client.js}"

echo "== CarPlay map -> cluster: instalador =="
[ "$(id -u)" = 0 ] || { echo "ERRO: rode como root."; exit 1; }
[ -x "$MD" ] || { echo "ERRO: mgu-deploy nao encontrado ($MD). Instale o MGU Store primeiro."; exit 1; }
[ -f "$PRODUCER" ] || { echo "ERRO: produtor nao encontrado em $PRODUCER"; exit 1; }

echo "-- checando pre-requisitos --"
if ! "$MD" status 2>/dev/null | grep -qi 'cluster-render'; then
  echo "ERRO: cluster-render nao detectado. Instale-o pelo MGU Store antes (ele faz o trabalho pesado)."
  exit 1
fi
"$MD" status 2>/dev/null | grep -qi 'app-privacy' || \
  echo "AVISO: app-privacy nao detectado — necessario SO para o app de liga/desliga (MGU Store)."

# cluster_render_client.js vem do pacote cluster-render (robertn, GPL) — nao e redistribuido aqui.
if [ ! -f "$CLIENT" ]; then
  echo ""
  echo "ERRO: cluster_render_client.js nao encontrado."
  echo "Ele faz parte do cluster-render (robertn). Pegue-o do pacote que voce baixou do MGU Store:"
  echo "    tar xzf cluster-render@*.tgz   # procure files/cluster_render_client.js"
  echo "e rode de novo apontando pra ele:"
  echo "    ./install/install.sh /caminho/para/cluster_render_client.js"
  echo "(ou copie-o para producer/cluster_render_client.js)"
  exit 1
fi

echo "-- montando o pacote do produtor (com shas corretos) --"
TMP=$(mktemp -d)
mkdir -p "$TMP/files" "$TMP/units"
cp "$PRODUCER" "$TMP/files/carplay-map-cluster.js"
cp "$CLIENT"   "$TMP/files/cluster_render_client.js"
cp "$PKG/units/carplay-map.service" "$TMP/units/"
SHA_P=$(sha256sum "$TMP/files/carplay-map-cluster.js" | awk '{print $1}')
SHA_C=$(sha256sum "$TMP/files/cluster_render_client.js" | awk '{print $1}')
node -e '
  var fs=require("fs");
  var d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  (d.files||[]).forEach(function(f){
    if(f.path==="carplay-map-cluster.js") f.sha256=process.argv[2];
    if(f.path==="cluster_render_client.js") f.sha256=process.argv[3];
  });
  fs.writeFileSync(process.argv[4], JSON.stringify(d,null,2));
' "$PKG/component.json" "$SHA_P" "$SHA_C" "$TMP/component.json"
( cd "$TMP" && tar czf /tmp/carplay-map.tool.tgz component.json files units )
rm -rf "$TMP"

echo "-- instalando o produtor (tool) --"
"$MD" check   --artifact /tmp/carplay-map.tool.tgz
"$MD" install --artifact /tmp/carplay-map.tool.tgz --yes

if [ -f "$APP_TGZ" ]; then
  echo "-- instalando o app 'Mapa no Cluster' (liga/desliga) --"
  "$MD" install --artifact "$APP_TGZ" --yes || \
    echo "AVISO: app nao instalou (app-privacy esta instalado? ele e obrigatorio pro app)."
fi

systemctl restart carplay-map.service 2>/dev/null || true
echo ""
echo "== PRONTO =="
echo "Abra o CarPlay num mapa (layout Dashboard: mapa + os cards do lado) e olhe o cluster."
echo "Liga/desliga pelo app 'Mapa no Cluster'. Sobe sozinho no boot."
"$MD" status 2>/dev/null | grep -iE 'carplay-map|cluster-render|carplay_map_toggle' || true
