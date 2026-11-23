# Despliegue

Guía para poner CMS-MULTISECCIÓN en producción en un servidor Linux, con Caddy como proxy inverso HTTPS y `systemd` (D-065). Los archivos de ejemplo están en [`deploy/`](../deploy/). Si se usa nginx, está [`deploy/nginx.conf.example`](../deploy/nginx.conf.example). En otros sistemas el esquema es el mismo: un proxy HTTPS delante y un supervisor que arranca y reinicia el proceso.

```text
Internet ──https──▶ Caddy (TLS, http→https, límite de cuerpo) ──http──▶ 127.0.0.1:3000 node backend/server.js
                                                                        └─ /var/lib/cms-multiseccion (base, archivos, copias)
```

**Alcance de esta guía:** las configuraciones de `deploy/` se han redactado y comprobado de forma estática; una prueba verifica que son coherentes con la configuración de la aplicación. No se han ejecutado en un servidor Linux real: hay que validarlas en el primer despliegue (ver «Puesta en marcha»).

## Requisitos

- Linux con `systemd` (por ejemplo Debian 12 o Ubuntu 24.04).
- **Node.js ≥ 24.7** (Argon2 nativo; ver `npm run check`).
- Caddy 2 (o nginx con certbot) y un dominio cuyo DNS apunte al servidor, con los puertos 80 y 443 abiertos.
- Disco local para los datos: no una unidad de red ni una carpeta sincronizada (D-006).
- Opcional: `restic` y un destino externo para las copias.

La aplicación **no tiene dependencias de ejecución**: `npm ci --omit=dev` no instala nada. Tiptap y esbuild solo sirven para regenerar el bundle del editor, que ya está en el repositorio.

## Instalación

```sh
# Usuario sin privilegios y directorios
sudo useradd --system --home /var/lib/cms-multiseccion --shell /usr/sbin/nologin cms
sudo install -d -o cms -g cms -m 0700 /var/lib/cms-multiseccion /var/lib/cms-multiseccion/database /var/lib/cms-multiseccion/storage
sudo install -d -o root -g cms -m 0750 /etc/cms-multiseccion

# Código (propiedad de root: el servicio no puede modificarlo)
sudo git clone <repositorio> /opt/cms-multiseccion
cd /opt/cms-multiseccion && sudo npm ci --omit=dev

# Configuración
sudo install -o root -g cms -m 0640 deploy/cms.env.example /etc/cms-multiseccion/cms.env
sudoedit /etc/cms-multiseccion/cms.env      # APP_BASE_URL con su dominio

# Base de datos, administrador general y comprobación
alias cms='sudo -u cms node --env-file=/etc/cms-multiseccion/cms.env'
cms scripts/db.js migrate
cms scripts/admin.js create                 # pide la contraseña de forma oculta
cms scripts/check-env.js                    # debe terminar en «Entorno correcto»
```

`scripts/check-env.js` comprueba en producción:

- `HOST` local y `TRUST_PROXY=true`;
- que `LOG_LEVEL` no sea `debug`;
- que el almacenamiento sea escribible;
- que exista el administrador general;
- el estado de las copias.

## Servicio y proxy

```sh
sudo cp deploy/cms-multiseccion.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cms-multiseccion
systemctl status cms-multiseccion
journalctl -u cms-multiseccion -f           # registros (JSON, una línea por evento)

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # con su dominio
sudo systemctl reload caddy
```

**El servicio:**

- se ejecuta como `cms`;
- solo puede escribir en `/var/lib/cms-multiseccion`;
- se reinicia si termina por un error.

**Proceso:**

- **Error fatal:** registra el error, libera el bloqueo y termina con código 1. `systemd` lo vuelve a arrancar.
- **Parada:** `SIGTERM` cierra de forma ordenada; termina las peticiones en curso durante 10 s como máximo.

**HTTPS obligatorio:**

- Caddy obtiene el certificado y redirige `http` a `https`.
- La aplicación exige `APP_BASE_URL` con `https` en producción. Con ella activa la cookie de sesión `Secure` y HSTS (un año), y comprueba el origen de las peticiones que modifican estado.
- Como escucha solo en `127.0.0.1`, no se puede llegar a ella sin pasar por el proxy.

**Límites:**

- **Aplicación:** 1200 peticiones y 120 escrituras por minuto e IP (D-064), y el inicio de sesión tiene el suyo, más estricto. Con `TRUST_PROXY=true` la IP es la del cliente que indica el proxy.
- **Caddy:** corta los cuerpos de más de 12 MB.
- **nginx:** el ejemplo añade además un límite por IP.

## Puesta en marcha

Antes de abrir el sitio:

1. `https://<dominio>/health` responde `{"status":"ok"}` y `http://<dominio>/` redirige a `https`.
2. Las cabeceras de la portada incluyen `Strict-Transport-Security`, `Content-Security-Policy` y `X-Content-Type-Options` (`curl -sI https://<dominio>/`).
3. `curl -s http://<IP-del-servidor>:3000/` desde otra máquina **no** responde.
4. Acceso al panel en `https://<dominio>/admin/`, creación de una sección y publicación de un contenido de prueba.
5. Copia manual desde **Sistema → Copias de seguridad** y su verificación.
6. Simulacro de restauración (ver abajo) antes de cargar contenido real.

**Colores del cliente (opcional).** Si el cliente tiene paletas exclusivas:

1. Instale su archivo con `sudo install -o root -g cms -m 0640 themes.json /etc/cms-multiseccion/themes.json`.
2. Añada `THEMES_FILE=/etc/cms-multiseccion/themes.json` a `cms.env`.
3. Ejecute `cms scripts/check-env.js`, que valida las paletas y su contraste.
4. Reinicie el servicio.

El formato está en [THEMES.md](THEMES.md#paletas-exclusivas-de-un-cliente-themes_file).

## Copias de seguridad

Las copias automáticas se guardan en `/var/lib/cms-multiseccion/storage/backups` (ver [BACKUPS.md](BACKUPS.md)). En el mismo disco no protegen de su pérdida, así que hay que llevarlas fuera del servidor.

**Fuera del servidor, cifradas, con restic (D-065):**

```sh
sudo apt install restic
sudo install -m 0600 /dev/null /etc/cms-multiseccion/restic.password   # y escriba una contraseña larga
sudoedit /etc/cms-multiseccion/restic.env      # RESTIC_REPOSITORY=… y RESTIC_PASSWORD_FILE=/etc/cms-multiseccion/restic.password
sudo chmod 0600 /etc/cms-multiseccion/restic.env
sudo sh -c 'set -a; . /etc/cms-multiseccion/restic.env; restic init'
sudo cp deploy/cms-offsite-backup.service deploy/cms-offsite-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cms-offsite-backup.timer
```

- Restic cifra en origen, deduplica y comprueba el repositorio.
- [`deploy/offsite-backup.sh`](../deploy/offsite-backup.sh) envía solo las copias completas y conserva 14 diarias, 8 semanales y 12 mensuales.
- **Guarde la contraseña de restic también fuera del servidor.** Sin ella, las copias externas no se pueden descifrar.

**Restaurar desde fuera:**

```sh
sudo sh -c 'set -a; . /etc/cms-multiseccion/restic.env; restic restore latest --target /tmp/recuperado'
cms scripts/backup.js verify-dir /tmp/recuperado/var/lib/cms-multiseccion/storage/backups/<id>
sudo cp -a /tmp/recuperado/var/lib/cms-multiseccion/storage/backups/<id> /var/lib/cms-multiseccion/storage/backups/
sudo chown -R cms:cms /var/lib/cms-multiseccion/storage/backups/<id>
sudo systemctl stop cms-multiseccion
cms scripts/backup.js restore <id> --confirm
sudo systemctl start cms-multiseccion
```

**Simulacro:** conviene restaurar periódicamente en otra máquina, con la misma guía, para comprobar que las copias sirven.

## Actualizar a una versión nueva

```sh
cms scripts/backup.js create                     # copia antes de tocar nada
sudo systemctl stop cms-multiseccion
cd /opt/cms-multiseccion && sudo git pull && sudo npm ci --omit=dev
cms scripts/db.js migrate                        # el servidor no arranca con migraciones pendientes
cms scripts/check-env.js
sudo systemctl start cms-multiseccion
```

Las migraciones solo avanzan. Para volver atrás se restaura la copia hecha antes de actualizar con el código anterior: la restauración rechaza una copia de un esquema más nuevo que el código.

## Supervisión

- **Disponibilidad:** `GET /health`, que responde `200` sin sesión.
- **Registros:**
  - `journalctl -u cms-multiseccion` muestra los errores, los avisos de «Límite de peticiones alcanzado» y los fallos de las copias automáticas;
  - el registro no contiene contraseñas, tokens ni cookies.
- **Auditoría:** **Sistema → Auditoría**. Conviene **verificar la integridad** de vez en cuando; la verificación compara la cadena con las copias.
- **Rendimiento orientativo:** `npm run bench` en una máquina de pruebas (ver [ROADMAP.md](ROADMAP.md#bloque-11--detalle)).
