![unipi logo](https://github.com/UniPiTechnology/evok-web-jq/raw/main/www/css/images/unipi-logo-short-cmyk.svg?sanitize=true "Unipi logo")

# Evok Web

Evok Web is a simple web interface of [Evok], the API of the Unipi controllers. It shows the devices
of the controller grouped by its units, switches the outputs and configures the devices by the JSON API
and the WebSocket of Evok.

It is plain HTML, CSS and JavaScript (`www/`) without libraries and without a build, it works
without the Internet.

## Features

- The units of the controller in a list: the sections of the controller, the extensions of each serial
  bus (with the settings of the port, e.g. `19200 8N1`), other Modbus TCP servers and the 1-Wire sensors.
  A unit shows its digital and analog inputs and outputs, relays, user LEDs, data points and sensors,
  filtered by *All / Inputs / Outputs / Analog*, and its watchdog and Modbus scan.
- Live values by the WebSocket of Evok, a unit which does not respond, a lost 1-Wire sensor and a running
  pulse or sequence of an output are marked.
- The configuration of a device by its gear: the modes, the debounce and the counter of a DI, DirectSwitch,
  the PWM of a DO, the modes of the analog inputs and outputs, the watchdog, the aliases.
- *Save to flash* and *Reset units* for the chosen units.
- The token of the API of Evok, entered once and kept in the browser.
- Light and dark mode, by the choice of the user or the theme of the system.
- Works on a phone.

Evok Web 3.1 requires Evok 3.1, an older Evok has another API.

## Installation

Evok Web can be installed by apt. You must have Evok installed before,
see the [Evok installation instructions](https://github.com/UniPiTechnology/evok/blob/main/docs/installation.md).

Install/Upgrade:

```bash
sudo apt-get update
sudo apt-get install -y evok-web
```

The page is served by [Nginx] by HTTPS on port 443 of the controller: open `https://<address of the controller>/`,
`http://` is redirected to it. The certificate is self-signed, generated for the controller by the package `ssl-cert`:
the browser warns about it until it is accepted, see [HTTPS](#https) for your own certificate.

### Installation without apt

Evok Web is a set of static files, it can be installed by hand from this repository, e.g. on a controller
without the package repository of Unipi. Evok must be installed and running. Do not mix it with the package
`evok-web`: it owns the same files, its upgrade replaces them (remove it by `sudo apt-get remove evok-web` first).
`/opt/evok` itself is the Python environment of Evok, only `/opt/evok/www` belongs to Evok Web.

```bash
# Nginx, the self-signed certificate of the controller and the files of Evok Web
sudo apt-get install -y nginx ssl-cert
git clone https://github.com/UniPiTechnology/evok-web-jq.git
sudo mkdir -p /opt/evok/www
sudo cp -r evok-web-jq/www/. /opt/evok/www/

# the site of Nginx; the default site of Nginx listens on port 80 too, it is disabled
sudo cp evok-web-jq/nginx-site.conf /etc/nginx/sites-available/evok
sudo ln -sf /etc/nginx/sites-available/evok /etc/nginx/sites-enabled/evok
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Without `git`, download the archive of the repository (*Code* › *Download ZIP*) and unpack it instead.
The files can be copied to another directory too, then change `root` and `alias` in the site of Nginx.

An upgrade copies the files of `www/` again; remove `/opt/evok/www` first to delete the files which
were removed from Evok Web (e.g. the libraries of jQuery of an older version). To uninstall, remove
`/etc/nginx/sites-enabled/evok`, `/etc/nginx/sites-available/evok` and `/opt/evok/www` and reload Nginx.

## Configuration

`nginx-site.conf` is the site of Nginx installed by the package (`/etc/nginx/sites-available/evok`). It redirects
HTTP to HTTPS, serves `www/` (installed to `/opt/evok/www`) and forwards `/json`, `/rest`, `/bulk`, `/rpc`, `/version` and `/ws`
to Evok on `127.0.0.1:8080`, the default address of its API. Another port of Evok is set in `upstream evok`.

Nginx passes the address of the client to Evok in `X-Real-IP` and `X-Forwarded-For`. Evok uses it, e.g. in its log
of a request without the token, only with nginx in `trusted_downstream` of `apis` in its configuration:

```yaml
apis:
  trusted_downstream: ["127.0.0.1"]
```

When Evok requires a token (`token` or `read_token` of `apis` in its configuration, see
[Security](https://github.com/UniPiTechnology/evok/blob/main/docs/security.md)), the page asks for it
and keeps it in the browser; *Forget token* by the key button removes it. With the `read_token` the page
only reads, a change is refused by Evok. Nginx hides `WWW-Authenticate` of the replies of Evok, the browser
would show its own login dialog instead of the dialog of the page.

Another web server, e.g. [Apache], has to serve `www/` and forward the same paths, the WebSocket `/ws`
with the original `Host` of the request (Evok refuses a WebSocket of another origin).

### Logs

The errors of the site are logged to the system log only, warnings and worse (the errors of the start of Nginx
stay in `/var/log/nginx/error.log` of `nginx.conf`):

```bash
journalctl -t evok_web
```

The requests are not logged, each would be a write to the flash of the controller. To log them to the system
log, uncomment the line `access_log syslog:…` in the site and comment out `access_log off;`.

### HTTPS

The site uses the self-signed certificate of the package `ssl-cert` (`/etc/ssl/certs/ssl-cert-snakeoil.pem`,
included by `snippets/snakeoil.conf` of Nginx), made for the hostname of the controller. A new one, e.g. after
a change of the hostname:

```bash
sudo make-ssl-cert generate-default-snakeoil --force-overwrite
sudo systemctl reload nginx
```

Your own certificate, e.g. of the CA of your company: copy it to the controller and replace the line
`include snippets/snakeoil.conf;` in `/etc/nginx/sites-available/evok` by

```nginx
ssl_certificate      /etc/ssl/certs/evok.pem;    # the certificate with its chain
ssl_certificate_key  /etc/ssl/private/evok.key;  # readable by root only
```

then `sudo nginx -t && sudo systemctl reload nginx`. An upgrade of the package `evok-web` asks before it
replaces the changed site (a configuration file of the package).

## Development

- `www/index.html` - the page and its dialogs
- `www/css/style.css` - the styles, the light and the dark theme by CSS variables
- `www/js/main.js` - the logic: the API, the WebSocket, the units and the devices, the dialogs

To try a change, copy the files to `/opt/evok/www` of a controller with Evok, or serve `www/` by any web server
which forwards the paths above to Evok.

The code is formatted by [Prettier]:

```bash
npx prettier@3.3.3 --write www/
```

## Security

See [SECURITY.md](SECURITY.md).

[Nginx]: https://nginx.org/
[Apache]: https://httpd.apache.org/
[Evok]: https://github.com/UniPiTechnology/evok
[Prettier]: https://prettier.io/
