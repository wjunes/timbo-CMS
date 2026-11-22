#!/bin/sh
# Copia cifrada de las copias de seguridad fuera del servidor, con restic
# (ver docs/DEPLOYMENT.md). La ejecuta cms-offsite-backup.timer una vez al día.
#
# /etc/cms-multiseccion/restic.env (root:root, 0600) define:
#   RESTIC_REPOSITORY=sftp:copias@otro-servidor:/srv/restic/cms   (o s3:, b2:, rest:…)
#   RESTIC_PASSWORD_FILE=/etc/cms-multiseccion/restic.password
# Guarde la contraseña de restic también fuera del servidor: sin ella, las
# copias externas no se pueden descifrar.
set -eu

BACKUPS=/var/lib/cms-multiseccion/storage/backups

# Solo se envían copias completas (las que están a medias empiezan por ".tmp-").
restic backup "$BACKUPS" --tag cms-multiseccion --exclude "$BACKUPS/.tmp-*" --exclude "$BACKUPS/.lock"

# Retención externa, más larga que la local.
restic forget --tag cms-multiseccion --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune

# Comprobación de una parte de los datos del repositorio en cada ejecución.
restic check --read-data-subset=5%
