class LocationGlobe {
    constructor(parentId) {
        if (!parentId) throw "Missing parameters";

        const path = require("path");

        this._geodata = require(path.join(__dirname, "assets/misc/grid.json"));
        require(path.join(__dirname, "assets/vendor/encom-globe.js"));
        this.ENCOM = window.ENCOM;

        // Create DOM and include lib
        this.parent = document.getElementById(parentId);
        this.parent.innerHTML += `<div id="mod_globe">
            <div id="mod_globe_innercontainer">
                <h1>WORLD VIEW<i>GLOBAL NETWORK MAP</i></h1>
                <h2>ENDPOINT LAT/LON<i class="mod_globe_headerInfo">0.0000, 0.0000</i></h2>
                <div id="mod_globe_canvas_placeholder"></div>
                <h3>OFFLINE</h3>
            </div>
        </div>`;

        this.lastgeo = {};
        this.conns = [];
        this._satelliteItems = [];
        this._eventMarkers = [];
        this._liveSatelliteRetries = 0;

        setTimeout(() => {
            let container = document.getElementById("mod_globe_innercontainer");
            let placeholder = document.getElementById("mod_globe_canvas_placeholder");

            // Create Globe
            this.globe = new this.ENCOM.Globe(placeholder.offsetWidth, placeholder.offsetHeight, {
                font: window.theme.cssvars.font_main,
                data: [],
                tiles: this._geodata.tiles,
                baseColor: window.theme.globe.base || `rgb(${window.theme.r},${window.theme.g},${window.theme.b})`,
                markerColor: window.theme.globe.marker || `rgb(${window.theme.r},${window.theme.g},${window.theme.b})`,
                pinColor: window.theme.globe.pin || `rgb(${window.theme.r},${window.theme.g},${window.theme.b})`,
                satelliteColor: window.theme.globe.satellite || `rgb(${window.theme.r},${window.theme.g},${window.theme.b})`,
                scale: 1.1,
                viewAngle: 0.630,
                dayLength: 1000 * 45,
                introLinesDuration: 2000,
                introLinesColor: window.theme.globe.marker || `rgb(${window.theme.r},${window.theme.g},${window.theme.b})`,
                maxPins: 300,
                maxMarkers: 100
            });

            // Place Globe
            placeholder.remove();
            container.append(this.globe.domElement);

            // Init animations
            this._animate = () => {
                if (window.mods.globe.globe) {
                    window.mods.globe.globe.tick();
                }
                if (window.mods.globe._animate) {
                    setTimeout(() => {
                        try {
                            requestAnimationFrame(window.mods.globe._animate);
                        } catch(e) {
                            // We probably got caught in a theme change. Print it out but everything should keep running fine.
                            console.warn(e);
                        }
                    }, 1000 / 30);
                }
            };
            this.globe.init(window.theme.colors.light_black, () => {
                this._animate();
                window.audioManager.scan.play();
            });

            // resize handler
            this.resizeHandler = () => {
                let canvas = document.querySelector("div#mod_globe canvas");
                window.mods.globe.globe.camera.aspect = canvas.offsetWidth / canvas.offsetHeight;
                window.mods.globe.globe.camera.updateProjectionMatrix();
                window.mods.globe.globe.renderer.setSize(canvas.offsetWidth, canvas.offsetHeight);
            };
            window.addEventListener("resize", this.resizeHandler);

            // Connections
            this.conns = [];
            this.addConn = ip => {
                let data = null;
                try {
                    data = window.mods.netstat.geoLookup.get(ip);
                } catch {
                    // do nothing
                }
                let geo = (data !== null ? data.location : {});
                if (geo.latitude && geo.longitude) {
                    const lat = Number(geo.latitude);
                    const lon = Number(geo.longitude);
                    window.mods.globe.conns.push({
                        ip,
                        pin: window.mods.globe.globe.addPin(lat, lon, "", 1.2),
                    });
                }
            };
            this.removeConn = ip => {
                let index = this.conns.findIndex(x => x.ip === ip);
                this.conns[index].pin.remove();
                this.conns.splice(index, 1);
            };

            // Add live satellite and event data
            this._initLiveGlobeData();
        }, 2000);

        // Init updaters when intro animation is done
        setTimeout(() => {
            this.updateLoc();
            this.locUpdater = setInterval(() => {
                this.updateLoc();
            }, 1000);

            this.updateConns();
            this.connsUpdater = setInterval(() => {
                this.updateConns();
            }, 3000);
        }, 4000);
    }

    addRandomConnectedMarkers() {
        const randomLat = this.getRandomInRange(40, 90, 3);
        const randomLong = this.getRandomInRange(-180, 0, 3);
        this.globe.addMarker(randomLat, randomLong, '');
        this.globe.addMarker(randomLat - 20, randomLong + 150, '', true);
    }
    async _fetchJSON(url) {
        try {
            if (typeof fetch !== 'function') {
                throw new Error('fetch unavailable');
            }
            const resp = await fetch(url);
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            return await resp.json();
        } catch (error) {
            console.warn('LocationGlobe fetch failed:', url, error);
            throw error;
        }
    }
    async _initLiveGlobeData() {
        await this.updateLiveSatellites();
        await this.updateLiveEvents();

        this.satelliteUpdater = setInterval(() => {
            this.updateLiveSatellites();
        }, 15000);

        this.eventUpdater = setInterval(() => {
            this.updateLiveEvents();
        }, 300000);
    }
    _clearEventMarkers() {
        this._eventMarkers.forEach(marker => marker.remove());
        this._eventMarkers = [];
    }
    _loadFallbackSatellites() {
        if (this._satelliteItems.length > 0) {
            return;
        }
        let constellation = [];
        for (var i = 0; i < 2; i++) {
            for (var j = 0; j < 3; j++) {
                constellation.push({
                    lat: 50 * i - 30 + 15 * Math.random(),
                    lon: 120 * j - 120 + 30 * i,
                    altitude: Math.random() * (1.7 - 1.3) + 1.3
                });
            }
        }
        this._satelliteItems = this.globe.addConstellation(constellation);
    }
    async updateLiveSatellites() {
        if (!this.globe || window.mods.netstat.offline) {
            return;
        }

        try {
            const issData = await this._fetchJSON('https://api.open-notify.org/iss-now.json');
            if (issData && issData.message === 'success' && issData.iss_position) {
                const lat = parseFloat(issData.iss_position.latitude);
                const lon = parseFloat(issData.iss_position.longitude);
                const altitude = 1.35;

                this._satelliteItems.forEach(item => item.remove());
                this._satelliteItems = [];

                const issSatellite = this.globe.addSatellite(lat, lon, altitude, {
                    waveColor: '#33fcff',
                    coreColor: '#32aaff',
                    shieldColor: '#88e7ff',
                    size: 1.3
                });
                this._satelliteItems.push(issSatellite);
                this._liveSatelliteRetries = 0;
            } else {
                throw new Error('Unexpected ISS response');
            }
        } catch (error) {
            this._liveSatelliteRetries += 1;
            if (this._liveSatelliteRetries > 1) {
                this._loadFallbackSatellites();
            }
        }
    }
    async updateLiveEvents() {
        if (!this.globe || window.mods.netstat.offline) {
            return;
        }

        try {
            const data = await this._fetchJSON('https://eonet.gsfc.nasa.gov/api/v3/events?status=open');
            if (!data || !Array.isArray(data.events)) {
                throw new Error('Unexpected EONET response');
            }

            this._clearEventMarkers();

            const events = data.events.filter(event => event.geometry && event.geometry.length > 0);
            events.slice(0, 3).forEach(event => {
                let geom = event.geometry.find(g => g.type === 'Point') || event.geometry[0];
                if (!geom || !Array.isArray(geom.coordinates)) {
                    return;
                }
                const [lon, lat] = geom.coordinates;
                const marker = this.globe.addMarker(lat, lon, event.title, false, 1.2, '#ff3333');
                this._eventMarkers.push(marker);
                setTimeout(() => {
                    marker.remove();
                }, 60000);
            });
        } catch (error) {
            console.warn('Could not update NASA event markers:', error);
        }
    }
    addTemporaryConnectedMarker(ip) {
        let data = window.mods.netstat.geoLookup.get(ip);
        let geo = (data !== null ? data.location : {});
        if (geo.latitude && geo.longitude) {
            const lat = Number(geo.latitude);
            const lon = Number(geo.longitude);

            window.mods.globe.conns.push({
                ip,
                pin: window.mods.globe.globe.addPin(lat, lon, "", 1.2)
            });
            let mark = window.mods.globe.globe.addMarker(lat, lon, '', true);
            setTimeout(() => {
                mark.remove();
            }, 3000);
        }
    }
    removeMarkers() {
        this.globe.markers.forEach(marker => { marker.remove(); });
        this.globe.markers = [];
    }
    removePins() {
        this.globe.pins.forEach(pin => {
            pin.remove();
        });
        this.globe.pins = [];
    }
    getRandomInRange(from, to, fixed) {
        return (Math.random() * (to - from) + from).toFixed(fixed) * 1;
    }
    updateLoc() {
        if (window.mods.netstat.offline) {
            document.querySelector("div#mod_globe").setAttribute("class", "offline");
            document.querySelector("i.mod_globe_headerInfo").innerText = "(OFFLINE)";

            this.removePins();
            this.removeMarkers();
            this.conns = [];
            this.lastgeo = {
                latitude: 0,
                longitude: 0
            };
        } else {
            this.updateConOnlineConnection().then(() => {
                document.querySelector("div#mod_globe").setAttribute("class", "");
            }).catch(() => {
                document.querySelector("i.mod_globe_headerInfo").innerText = "UNKNOWN";
            })
        }
    }
    async updateConOnlineConnection() {
        let newgeo = window.mods.netstat.ipinfo.geo;
        newgeo.latitude = Math.round(newgeo.latitude*10000)/10000;
        newgeo.longitude = Math.round(newgeo.longitude*10000)/10000;

        if (newgeo.latitude !== this.lastgeo.latitude || newgeo.longitude !== this.lastgeo.longitude) {

            document.querySelector("i.mod_globe_headerInfo").innerText = `${newgeo.latitude}, ${newgeo.longitude}`;
            this.removePins();
            this.removeMarkers();
            //this.addRandomConnectedPoints();
            this.conns = [];

            this._locPin = this.globe.addPin(newgeo.latitude, newgeo.longitude, "", 1.2);
            this._locMarker = this.globe.addMarker(newgeo.latitude, newgeo.longitude, "", false, 1.2);
        }

        this.lastgeo = newgeo;
        document.querySelector("div#mod_globe").setAttribute("class", "");
    }
    updateConns() {
        if (!window.mods.globe.globe || window.mods.netstat.offline) return false;
        window.si.networkConnections().then(conns => {
            let newconns = [];
            conns.forEach(conn => {
                let ip = conn.peeraddress;
                let state = conn.state;
                if (state === "ESTABLISHED" && ip !== "0.0.0.0" && ip !== "127.0.0.1" && ip !== "::") {
                    newconns.push(ip);
                }
            });

            this.conns.forEach(conn => {
                if (newconns.indexOf(conn.ip) !== -1) {
                    newconns.splice(newconns.indexOf(conn.ip), 1);
                } else {
                    this.removeConn(conn.ip);
                }
            });

            newconns.forEach(ip => {
                this.addConn(ip);
            });
        });
    }
}

module.exports = {
    LocationGlobe
};
