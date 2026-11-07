# ABSOLUTE DATA — Bot administrador de WhatsApp

## Instalación
1. Necesitas Node.js 20 o superior.
2. Descomprime el ZIP.
3. En la carpeta del proyecto ejecuta: `npm install`
4. Ejecuta: `npm start`
5. Abre `http://localhost:3000` (o la URL que te dé tu hosting).
6. Escanea el QR con el número que usarás como bot: WhatsApp > Dispositivos vinculados > Vincular dispositivo.
7. Agrega ese número al grupo y hazlo administrador.
8. Actualiza el panel, selecciona el grupo y configura mensajes y reglas.

## Mantenerlo encendido
Para funcionar 24/7 debes alojarlo en un servidor Node.js que no se duerma. No cierres el proceso. En Replit, crea un proyecto Node.js, sube estos archivos y usa `npm start`; verifica que tu plan permita procesos persistentes.

## Importante
- Esta integración usa Baileys, una biblioteca no oficial que automatiza WhatsApp Web. WhatsApp puede limitar o bloquear el número.
- El bot solo puede borrar mensajes y expulsar participantes si tiene permisos de administrador.
- Los administradores agregados en “Números administradores protegidos” quedan exentos de la moderación. Usa números con código de país, por ejemplo 521XXXXXXXXXX.
- Para cambiar el intervalo, configura los minutos en el panel. El envío se comprueba cada minuto.
- Protege la URL del panel: esta versión inicial no incluye contraseña ni HTTPS. No la publiques abierta en internet. Antes de producción, añade autenticación y HTTPS.
- La detección de palabras y enlaces es literal y básica; revisa las reglas antes de activarlo en un grupo real.
