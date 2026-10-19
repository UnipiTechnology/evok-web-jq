![unipi logo](https://github.com/UniPiTechnology/evok-web-jq/raw/main/www/css/images/unipi-logo-short-cmyk.svg?sanitize=true "Unipi logo")

# EVOK WEB jQ

Evok web is a simple web application for [Evok]: it shows the devices of the controller grouped by its units,
switches the outputs and configures the devices by the JSON API and the WebSocket of Evok. It is plain
HTML, CSS and JavaScript (`www/`) without libraries and without a build, it works without the Internet.

To publish website on server, you need to configure and run a http server like [Nginx] or [Apache]
(`nginx-site.conf`), which serves `www/` and forwards `/json`, `/rest`, `/bulk`, `/rpc`, `/version` and `/ws` to Evok.

The code is formatted by Prettier: `npx prettier@3.3.3 --write www/`.


## Installation

Evok web can be installed by apt.
You must have Evok installed before. 
See [Evok installation instructions](https://github.com/UniPiTechnology/evok/docs/installation.md).

Install/Upgrade:
```bash
sudo su
apt-get update
apt-get install -y evok-web
```


[Nginx]:https://nginx.org/
[Apache]:https://httpd.apache.org/
[Evok]:https://github.com/UniPiTechnology/evok
