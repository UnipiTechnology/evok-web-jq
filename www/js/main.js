"use strict";

// The API is served by the same server as the page (nginx forwards it to Evok)
const API_URL = location.protocol + "//" + location.host;
const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

// the unit of the 1-Wire sensors in the list of the units
const ONEWIRE = "1-Wire";
// the DirectSwitch modes of a DI in the Simple mode, Evok sends ds_modes only in the DirectSwitch mode;
// all HW definitions of Evok have these ones
const DS_MODES = ["Simple", "Inverted", "Toggle"];
// the extra choice of the aliases in the dialog of saving, a circuit of a unit has no space
const SAVE_ALIASES = "aliases of devices";

// the cards of a unit in their order, a card is shown when the unit has a device of its types
const CARDS = [
    { title: "Digital inputs", devs: ["di"], filter: "inputs", kind: "tiles" },
    { title: "Digital outputs", devs: ["do"], filter: "outputs", kind: "rows" },
    { title: "Relay outputs", devs: ["ro"], filter: "outputs", kind: "rows" },
    { title: "User LEDs", devs: ["led"], filter: "outputs", kind: "rows" },
    { title: "Analog inputs", devs: ["ai"], filter: "analog", kind: "tiles" },
    { title: "Analog outputs", devs: ["ao"], filter: "analog", kind: "rows" },
    { title: "Data points", devs: ["data_point"], filter: "inputs", kind: "tiles" },
    { title: "Sensors", devs: ["temp", "1wdevice"], filter: "inputs", kind: "tiles" },
    { title: "1-Wire power", devs: ["owpower"], filter: "outputs", kind: "rows" },
];
const FILTERS = [
    ["all", "All"],
    ["inputs", "Inputs"],
    ["outputs", "Outputs"],
    ["analog", "Analog"],
];
// the device types with a dialog of their configuration
const CONFIGURABLE = ["di", "do", "ro", "led", "ai", "ao", "wd", "temp", "1wdevice"];

const collator = new Intl.Collator(undefined, { numeric: true });

const state = {
    // the last state of each device by "<dev>/<circuit>"
    devices: new Map(),
    // the running sequencer of an output by the key of the output
    sequencers: new Map(),
    // the settings of the serial port of a Modbus RTU unit by its circuit, e.g. "19200 8N1"
    serialSettings: {},
    // the name of the serial bus of a Modbus RTU unit by its circuit, e.g. "RS485_1"
    serialBuses: {},
    // the update functions of the devices shown by the key of the device
    views: new Map(),
    unit: null,
    filter: "all",
    // the token of Evok (token or read_token of apis in its configuration), "" when Evok requires none
    token: loadSetting("evok_token") || "",
    // a request was refused by 401, the WebSocket is not connected until a token is entered
    authRequired: false,
    ws: null,
    version: "",
};

// # Helpers

function loadSetting(name) {
    try {
        return localStorage.getItem(name);
    } catch (error) {
        return null;
    }
}

function saveSetting(name, value) {
    try {
        if (value === null || value === "") {
            localStorage.removeItem(name);
        } else {
            localStorage.setItem(name, value);
        }
    } catch (error) {}
}

// An element: h("div", {class: "tile", onclick: f}, child, ...), a child is a node, a text or null
function h(tag, attrs, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
        if (value === null || value === undefined || value === false) {
            continue;
        }
        if (name.startsWith("on")) {
            element.addEventListener(name.slice(2), value);
        } else if (name === "class") {
            element.className = value;
        } else if (value === true) {
            element.setAttribute(name, "");
        } else {
            element.setAttribute(name, value);
        }
    }
    for (const child of children.flat()) {
        if (child !== null && child !== undefined && child !== false) {
            element.append(child);
        }
    }
    return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function gearIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute(
        "d",
        "M6.6 1.5h2.8l.4 1.9 1.3.7 1.8-.7 1.4 2.4-1.4 1.3v1.6l1.4 1.3-1.4 2.4-1.8-.7-1.3.7-.4 1.9H6.6l-.4-1.9-1.3-.7-1.8.7-1.4-2.4 1.4-1.3V7.1L1.7 5.8l1.4-2.4 1.8.7 1.3-.7z",
    );
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.2");
    path.setAttribute("stroke-linejoin", "round");
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "8");
    circle.setAttribute("cy", "8");
    circle.setAttribute("r", "2");
    circle.setAttribute("stroke", "currentColor");
    circle.setAttribute("stroke-width", "1.2");
    svg.append(path, circle);
    return svg;
}

function keyOf(dev, circuit) {
    return dev + "/" + circuit;
}

// A value of Evok can be null (before the first scan) or a string ('NaN', 'Infinity')
function formatNumber(value, digits) {
    if (value === null || value === undefined) {
        return "N/A";
    }
    if (typeof value === "number") {
        return value.toFixed(digits);
    }
    return String(value);
}

// 2_01 is shown as 2.01, ext2_01 as ext2.01
function circuitName(circuit) {
    const pos = circuit.lastIndexOf("_");
    return pos > 0 ? circuit.slice(0, pos) + "." + circuit.slice(pos + 1) : circuit;
}

// An alias of Evok has no spaces, they are shown and entered as spaces
function aliasText(alias) {
    return alias.replace(/_/g, " ");
}

function aliasValue(text) {
    return text.trim().replace(/ /g, "_");
}

function displayName(msg) {
    if (msg.alias) {
        return aliasText(msg.alias);
    }
    // the power of a 1-Wire bus has the circuit of its unit, e.g. 1
    return msg.dev === "owpower" ? "Power " + msg.circuit : circuitName(msg.circuit);
}

// The unit of a device: the circuit of its Modbus unit, ONEWIRE, or null for the devices of no unit
function unitOf(msg) {
    switch (msg.dev) {
        case "temp":
        case "1wdevice":
        case "owpower":
            return ONEWIRE;
        case "modbus_slave":
        case "wd":
        case "nv_save":
            return msg.circuit;
        case "device_info":
            // the controller has its model as the circuit, an extension its unit
            return msg.family === "Extension" ? msg.circuit : null;
        case "owbus":
        case "register":
        case "sequencer":
        case "serial_bus":
        case "tcp_bus":
        case "run":
            return null;
        default: {
            const pos = msg.circuit.lastIndexOf("_");
            return pos > 0 ? msg.circuit.slice(0, pos) : msg.circuit;
        }
    }
}

function devicesOf(dev) {
    const devices = [];
    for (const msg of state.devices.values()) {
        if (msg.dev === dev) {
            devices.push(msg);
        }
    }
    return devices.sort((a, b) => collator.compare(a.circuit, b.circuit));
}

function controllerInfo() {
    return devicesOf("device_info").find((info) => info.family !== "Extension") || null;
}

// The value of a unit which does not respond or of a lost 1-Wire sensor is the last known one;
// valid of a data point tells a missing sensor, e.g. a 1-Wire thermometer of xG18
function commNote(msg) {
    if (msg.lost === true) {
        return "sensor lost";
    }
    if (msg.valid === false) {
        return "invalid value";
    }
    if (msg.comm && msg.comm !== "ok") {
        return "no communication: " + msg.comm;
    }
    return "";
}

function sequencerNote(sequencer) {
    if (sequencer.name === "sequence" && sequencer.steps !== null && sequencer.steps !== undefined) {
        return "sequence " + sequencer.step + "/" + sequencer.steps;
    }
    return sequencer.name || "sequence";
}

// # The API

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// The text of an error reply of Evok: {"success": false, "errors": {"<type>": "<message>"}}
function errorText(reply, response) {
    if (reply && reply.errors) {
        return Object.entries(reply.errors)
            .map(([type, message]) => type + ": " + message)
            .join("\n");
    }
    return response ? response.status + " " + response.statusText : "Unknown error";
}

// A GET without a body, a POST of the JSON object of the body; returns the reply of Evok.
// The token is sent in the header Authorization, a refused one opens the dialog of the token.
async function api(path, body) {
    const options = { headers: {} };
    if (state.token) {
        options.headers.Authorization = "Bearer " + state.token;
    }
    if (body !== undefined) {
        options.method = "POST";
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
    }
    let response;
    try {
        response = await fetch(API_URL + path, options);
    } catch (error) {
        throw new ApiError(0, "Evok is not reachable");
    }
    let reply = null;
    try {
        reply = await response.json();
    } catch (error) {}
    if (!response.ok) {
        if (response.status === 401) {
            requestToken();
        }
        throw new ApiError(response.status, errorText(reply, response));
    }
    return reply;
}

// Sets the params of a device, its new state is shown at once; an error is shown, 401 by the dialog of the token
async function setDevice(dev, circuit, params) {
    try {
        const reply = await api("/json/" + dev + "/" + circuit, params);
        if (reply && reply.result) {
            handleDevices([reply.result]);
        }
    } catch (error) {
        showError(circuitName(circuit) + ": ", error);
    }
}

function showError(prefix, error) {
    if (error.status === 401) {
        return;
    }
    const toast = h("div", { class: "toast" }, prefix + error.message);
    document.getElementById("toasts").append(toast);
    setTimeout(() => toast.remove(), 8000);
}

// # Loading and the WebSocket

function setConnection(connection) {
    const element = document.getElementById("connection");
    element.dataset.state = connection;
    document.getElementById("connection-text").textContent = {
        live: "Live · WebSocket",
        connecting: "Connecting…",
        offline: "Evok is not reachable",
    }[connection];
}

// The Modbus RTU buses and the sequencers are not in /json/all
async function loadAll() {
    try {
        const buses = await api("/json/serial_bus/all").catch(() => []);
        for (const bus of buses) {
            const settings = bus.baudrate + " 8" + bus.parity + bus.stopbits;
            for (const circuit of bus.devices) {
                state.serialSettings[circuit] = settings;
                state.serialBuses[circuit] = bus.circuit;
            }
        }
        const [devices, sequencers] = await Promise.all([api("/json/all"), api("/json/sequencer/all").catch(() => [])]);
        handleDevices(devices.concat(sequencers));
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            setConnection("connecting");
        }
    } catch (error) {
        if (error.status !== 401) {
            setConnection("offline");
            const placeholder = document.getElementById("placeholder");
            if (placeholder) {
                placeholder.textContent = error.message;
            }
        }
    }
}

async function loadVersion() {
    try {
        const response = await fetch(API_URL + "/version");
        if (response.ok) {
            state.version = (await response.text()).trim();
            renderBrand();
        }
    } catch (error) {}
}

function connectWebSocket() {
    if (state.ws || state.authRequired) {
        return;
    }
    // a browser cannot set a header of a WebSocket
    const ws = new WebSocket(state.token ? WS_URL + "?token=" + encodeURIComponent(state.token) : WS_URL);
    let opened = false;
    state.ws = ws;
    ws.onopen = () => {
        opened = true;
        setConnection("live");
        loadAll();
    };
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (Array.isArray(msg)) {
            handleDevices(msg);
        } else if (msg.success === false) {
            showError("", new ApiError(400, errorText(msg)));
        } else {
            handleDevices([msg]);
        }
    };
    ws.onclose = () => {
        state.ws = null;
        setConnection("connecting");
        // a refused WebSocket (e.g. 401 of the token) tells no reason, REST reports it
        if (!opened) {
            loadAll();
        }
        setTimeout(connectWebSocket, 1000);
    };
}

// # The state of the devices

// Stores the states of the devices and shows them: a new device or unit renders the page again,
// a known device updates its view only
function handleDevices(list) {
    let structural = false;
    let units = false;
    for (const msg of list) {
        if (msg.dev === "sequencer") {
            handleSequencer(msg);
            continue;
        }
        const key = keyOf(msg.dev, msg.circuit);
        const old = state.devices.get(key);
        state.devices.set(key, msg);
        if (!old) {
            structural = true;
            continue;
        }
        if (commNote(old) !== commNote(msg)) {
            units = true;
        }
        const update = state.views.get(key);
        if (update) {
            update(msg);
        }
    }
    if (structural) {
        renderUnits();
        renderUnit();
        renderBrand();
    } else if (units) {
        renderUnits();
    }
}

function handleSequencer(msg) {
    const key = keyOf(msg.output.dev, msg.output.circuit);
    if (msg.running) {
        state.sequencers.set(key, msg);
    } else {
        state.sequencers.delete(key);
    }
    const update = state.views.get(key);
    const output = state.devices.get(key);
    if (update && output) {
        update(output);
    }
}

// # The units

function isLocalHost(host) {
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// The units by their groups: the controller, the extensions of each serial bus, the other Modbus TCP
// servers and the 1-Wire sensors
function unitGroups() {
    const units = new Set();
    for (const msg of state.devices.values()) {
        const unit = unitOf(msg);
        if (unit !== null) {
            units.add(unit);
        }
    }
    const controller = controllerInfo();
    const groups = new Map();
    for (const unit of [...units].sort(collator.compare)) {
        const slave = state.devices.get(keyOf("modbus_slave", unit));
        let title;
        if (unit === ONEWIRE) {
            title = "1-Wire";
        } else if (slave && slave.modbus_type === "RTU") {
            title = "Extensions · " + (state.serialBuses[unit] || slave.modbus_spec);
        } else if (slave && !isLocalHost(slave.modbus_spec)) {
            title = "Modbus TCP · " + slave.modbus_spec;
        } else {
            title = controller ? controller.family + " " + controller.model : "Controller";
        }
        if (!groups.has(title)) {
            groups.set(title, []);
        }
        groups.get(title).push(unit);
    }
    return groups;
}

function unitName(unit) {
    if (unit === ONEWIRE) {
        return "1-Wire bus";
    }
    const info = state.devices.get(keyOf("device_info", unit));
    if (info) {
        return unit + " · " + info.model;
    }
    return /^\d+$/.test(unit) ? "Section " + unit : unit;
}

// The bus of a Modbus unit: TCP · localhost · 2, RTU · 19200 8N1 · 3
function unitBus(unit) {
    const slave = state.devices.get(keyOf("modbus_slave", unit));
    if (!slave) {
        return unit === ONEWIRE ? devicesOf("temp").length + devicesOf("1wdevice").length + " sensors" : "";
    }
    const bus =
        slave.modbus_type === "TCP"
            ? isLocalHost(slave.modbus_spec)
                ? "localhost"
                : slave.modbus_spec
            : state.serialSettings[unit] || slave.modbus_spec;
    return slave.modbus_type + " · " + bus + " · " + slave.slave_id;
}

// A unit which does not respond, not a lost sensor or an invalid value
function unitOffline(unit) {
    for (const msg of state.devices.values()) {
        if (unitOf(msg) === unit && msg.comm && msg.comm !== "ok") {
            return true;
        }
    }
    return false;
}

function selectUnit(unit) {
    state.unit = unit;
    saveSetting("evok_unit", unit);
    if (location.hash !== "#" + encodeURIComponent(unit)) {
        history.replaceState(null, "", "#" + encodeURIComponent(unit));
    }
    renderUnits();
    renderUnit();
}

function renderUnits() {
    const groups = unitGroups();
    const units = [...groups.values()].flat();
    if (!units.includes(state.unit)) {
        const wanted = decodeURIComponent(location.hash.slice(1)) || loadSetting("evok_unit");
        state.unit = units.includes(wanted) ? wanted : units[0] || null;
    }
    document.getElementById("unit-list").replaceChildren(
        ...[...groups].map(([title, units]) =>
            h(
                "section",
                { class: "unit-group" },
                h("h2", { class: "unit-group-title" }, title),
                units.map((unit) => {
                    const offline = unitOffline(unit);
                    return h(
                        "button",
                        {
                            type: "button",
                            class: "unit-button",
                            "aria-current": unit === state.unit ? "page" : null,
                            onclick: () => selectUnit(unit),
                        },
                        h("span", { class: "dot" + (offline ? " is-offline" : "") }),
                        h(
                            "span",
                            { class: "unit-button-text" },
                            h("span", { class: "unit-button-name" }, unitName(unit)),
                            h("span", { class: "unit-button-bus" }, unitBus(unit)),
                        ),
                        offline ? h("span", { class: "badge amber" }, "offline") : null,
                    );
                }),
            ),
        ),
    );
    document.getElementById("unit-select").replaceChildren(
        ...[...groups].map(([title, units]) =>
            h(
                "optgroup",
                { label: title },
                units.map((unit) =>
                    h(
                        "option",
                        { value: unit, selected: unit === state.unit },
                        unitName(unit) + (unitOffline(unit) ? " (offline)" : ""),
                    ),
                ),
            ),
        ),
    );
}

function renderBrand() {
    const controller = controllerInfo();
    const parts = [];
    if (controller) {
        parts.push(controller.family + " " + controller.model + (controller.sn ? " · S/N " + controller.sn : ""));
    }
    if (state.version) {
        parts.push("Evok " + state.version);
    }
    document.getElementById("brand-device").textContent = parts.join(" · ");
}

// # A unit: its header, the filter and the cards of its devices

function renderUnit() {
    const content = document.getElementById("content");
    state.views.clear();
    if (state.unit === null) {
        if (state.devices.size) {
            content.replaceChildren(h("p", { class: "placeholder" }, "Evok has no devices to show."));
        }
        return;
    }
    const devices = [...state.devices.values()]
        .filter((msg) => unitOf(msg) === state.unit)
        .sort((a, b) => collator.compare(a.circuit, b.circuit));
    const cards = CARDS.filter((card) => state.filter === "all" || card.filter === state.filter)
        .map((card) => renderCard(card, devices))
        .filter((card) => card !== null);
    if (state.filter === "all") {
        const system = renderSystemCard();
        if (system) {
            cards.push(system);
        }
    }
    content.replaceChildren(
        h(
            "div",
            { class: "unit-header" },
            h("div", { class: "unit-title" }, h("h1", {}, unitName(state.unit)), h("p", {}, unitDescription())),
            h("div", { class: "spacer" }),
            h(
                "div",
                { class: "segments", role: "group", "aria-label": "Show" },
                FILTERS.map(([id, label]) =>
                    h(
                        "button",
                        {
                            type: "button",
                            "aria-pressed": state.filter === id ? "true" : "false",
                            onclick: () => {
                                state.filter = id;
                                renderUnit();
                            },
                        },
                        label,
                    ),
                ),
            ),
        ),
        cards.length
            ? h("div", { class: "cards" }, cards)
            : h("p", { class: "placeholder" }, "The unit has no devices of this kind."),
    );
}

function unitDescription() {
    const unit = state.unit;
    if (unit === ONEWIRE) {
        return "The sensors and the power of the 1-Wire buses";
    }
    const slave = state.devices.get(keyOf("modbus_slave", unit));
    const info = state.devices.get(keyOf("device_info", unit)) || controllerInfo();
    const parts = [];
    if (info) {
        parts.push(info.family + " " + info.model);
    }
    if (slave) {
        const bus =
            slave.modbus_type === "TCP"
                ? isLocalHost(slave.modbus_spec)
                    ? "localhost"
                    : slave.modbus_spec
                : slave.modbus_spec + (state.serialSettings[unit] ? " " + state.serialSettings[unit] : "");
        parts.push("Modbus " + slave.modbus_type + ", " + bus + ", address " + slave.slave_id);
    }
    return parts.join(" · ");
}

function renderCard(card, devices) {
    const items = devices.filter((msg) => card.devs.includes(msg.dev));
    if (!items.length) {
        return null;
    }
    return h(
        "section",
        { class: "card" },
        h(
            "div",
            { class: "card-header" },
            h("h2", {}, card.title),
            h("span", { class: "card-count" }, String(items.length)),
        ),
        h(
            "div",
            { class: card.kind },
            items.map((msg) => renderDevice(msg)),
        ),
    );
}

// The watchdog, the Modbus scan and the model of the unit
function renderSystemCard() {
    const unit = state.unit;
    const rows = [];
    const wd = state.devices.get(keyOf("wd", unit));
    if (wd) {
        rows.push(renderView(wd, watchdogRow));
    }
    const slave = state.devices.get(keyOf("modbus_slave", unit));
    if (slave) {
        rows.push(renderView(slave, modbusRow));
    }
    const info = state.devices.get(keyOf("device_info", unit));
    if (info) {
        rows.push(
            h(
                "div",
                { class: "row" },
                h("span", { class: "row-name" }, "Model"),
                h("span", { class: "row-value" }, info.model + (info.sn ? " · S/N " + info.sn : "")),
            ),
        );
    }
    if (!rows.length) {
        return null;
    }
    return h(
        "section",
        { class: "card" },
        h("div", { class: "card-header" }, h("h2", {}, "Unit")),
        h("div", { class: "rows" }, rows),
    );
}

// A view of a device: build(msg) returns {element, notes, switch, update(msg)}; the update is called
// on each change, the notes of the communication and of a running sequencer are shown in notes
function renderView(msg, build) {
    const key = keyOf(msg.dev, msg.circuit);
    const view = build(msg);
    const update = (msg) => {
        view.update(msg);
        const note = commNote(msg);
        view.element.classList.toggle("is-offline", !!note);
        const sequencer = state.sequencers.get(key);
        view.notes.replaceChildren(
            ...[
                note ? h("span", { class: "note" }, note) : null,
                sequencer ? h("span", { class: "note blue" }, sequencerNote(sequencer)) : null,
            ].filter((child) => child !== null),
        );
        if (view.switch) {
            // a change of an output is refused while its sequencer runs
            view.switch.disabled = !!sequencer;
        }
    };
    update(msg);
    state.views.set(key, update);
    return view.element;
}

function renderDevice(msg) {
    switch (msg.dev) {
        case "di":
            return renderView(msg, inputTile);
        case "do":
        case "ro":
        case "led":
        case "owpower":
            return renderView(msg, outputRow);
        case "ai":
            return renderView(msg, analogInputTile);
        case "ao":
            return renderView(msg, analogOutputRow);
        case "data_point":
            return renderView(msg, dataPointTile);
        default:
            return renderView(msg, sensorTile);
    }
}

function gearButton(msg) {
    if (!CONFIGURABLE.includes(msg.dev)) {
        return null;
    }
    return h(
        "button",
        {
            type: "button",
            class: "gear",
            "aria-label": "Configure " + displayName(msg),
            title: "Configure",
            onclick: () => openConfig(msg.dev, msg.circuit),
        },
        gearIcon(),
    );
}

function inputTile(msg) {
    const name = h("span", { class: "tile-name" });
    const status = h("span", { class: "state" });
    const counter = h("span", { class: "mono" });
    const ds = h("span", { class: "badge blue" });
    const notes = h("span", { class: "tile-meta" });
    const element = h(
        "div",
        { class: "tile" },
        h("div", { class: "tile-head" }, h("span", { class: "state-dot" }), name, gearButton(msg)),
        h("div", { class: "tile-meta" }, status, counter, ds),
        notes,
    );
    return {
        element,
        notes,
        update(msg) {
            name.textContent = displayName(msg);
            name.title = circuitName(msg.circuit);
            element.classList.toggle("is-on", msg.value === 1);
            status.textContent = msg.value === 1 ? "On" : msg.value === 0 ? "Off" : "N/A";
            counter.textContent =
                msg.counter !== null && msg.counter !== undefined && msg.counter_mode !== "Disabled"
                    ? "count " + msg.counter
                    : "";
            ds.hidden = msg.mode !== "DirectSwitch";
            ds.textContent = "DS · " + (msg.ds_mode || "");
        },
    };
}

function outputRow(msg) {
    const name = h("span", { class: "row-name" });
    const pwm = h("span", { class: "badge blue" });
    const notes = h("span", { class: "note-holder" });
    const toggle = h("button", { type: "button", class: "switch", role: "switch" });
    toggle.addEventListener("click", () => {
        const current = state.devices.get(keyOf(msg.dev, msg.circuit));
        setDevice(msg.dev, msg.circuit, { value: current && current.value === 1 ? 0 : 1 });
    });
    const element = h("div", { class: "row" }, name, notes, pwm, toggle, gearButton(msg));
    return {
        element,
        notes,
        switch: toggle,
        update(msg) {
            name.textContent = displayName(msg);
            name.title = circuitName(msg.circuit);
            toggle.setAttribute("aria-checked", msg.value === 1 ? "true" : "false");
            toggle.setAttribute("aria-label", displayName(msg));
            // the PWM of a DO, its value is 0 meanwhile
            pwm.hidden = !msg.pwm_duty;
            pwm.textContent = "PWM " + msg.pwm_duty + " % · " + msg.pwm_freq + " Hz";
        },
    };
}

function analogInputTile(msg) {
    const name = h("span", { class: "tile-name" });
    const mode = h("span", { class: "tile-caption" });
    const value = h("span", {});
    const unit = h("span", { class: "unit" });
    const notes = h("span", { class: "tile-meta" });
    const element = h(
        "div",
        { class: "tile" },
        h("div", { class: "tile-head" }, name, gearButton(msg)),
        h("span", { class: "tile-value" }, value, unit),
        mode,
        notes,
    );
    return {
        element,
        notes,
        update(msg) {
            name.textContent = displayName(msg);
            name.title = circuitName(msg.circuit);
            mode.textContent = msg.mode || "";
            if (msg.unit === null || msg.unit === undefined) {
                value.textContent = "Disabled";
                unit.textContent = "";
            } else {
                value.textContent = formatNumber(msg.value, 3);
                unit.textContent = " " + msg.unit;
            }
        },
    };
}

function analogOutputRow(msg) {
    const id = "ao-" + msg.circuit;
    const label = h("label", { class: "row-name", for: id });
    const slider = h("input", { type: "range", id: id });
    const text = h("span", { class: "row-value" });
    const notes = h("span", { class: "note-holder" });
    let unit = "";
    slider.addEventListener("input", () => {
        text.textContent = Number(slider.value).toFixed(2) + " " + unit;
    });
    slider.addEventListener("change", () => {
        setDevice(msg.dev, msg.circuit, { value: Number(slider.value) });
    });
    const element = h("div", { class: "row is-slider" }, label, slider, text, gearButton(msg), notes);
    return {
        element,
        notes,
        update(msg) {
            label.textContent = displayName(msg);
            const range = msg.range || [0, 10];
            unit = msg.unit || "";
            slider.min = range[0];
            slider.max = range[1];
            slider.step = (range[1] - range[0]) / 1000;
            // the slider is not moved while it is dragged
            if (typeof msg.value === "number" && document.activeElement !== slider) {
                slider.value = msg.value;
            }
            text.textContent = formatNumber(msg.value, 2) + " " + unit;
        },
    };
}

function dataPointTile(msg) {
    const caption = h("span", { class: "tile-caption" });
    const value = h("span", {});
    const unit = h("span", { class: "unit" });
    const notes = h("span", { class: "tile-meta" });
    const element = h(
        "div",
        { class: "tile" },
        h("div", { class: "tile-head" }, caption),
        h("span", { class: "tile-value" }, value, unit),
        notes,
    );
    return {
        element,
        notes,
        update(msg) {
            caption.textContent = displayName(msg) + (msg.name ? " · " + msg.name : "");
            value.textContent =
                typeof msg.value === "number" && !Number.isInteger(msg.value)
                    ? msg.value.toFixed(2)
                    : formatNumber(msg.value, 0);
            unit.textContent = msg.unit ? " " + msg.unit : "";
        },
    };
}

// A 1-Wire thermometer (temp) or another 1-Wire device (1wdevice), e.g. DS2438 with a humidity sensor
function sensorTile(msg) {
    const caption = h("span", { class: "tile-caption" });
    const value = h("span", {});
    const unit = h("span", { class: "unit" });
    const extra = h("span", { class: "tile-caption" });
    const notes = h("span", { class: "tile-meta" });
    const element = h(
        "div",
        { class: "tile" },
        h("div", { class: "tile-head" }, caption, gearButton(msg)),
        h("span", { class: "tile-value" }, value, unit),
        extra,
        notes,
    );
    return {
        element,
        notes,
        update(msg) {
            caption.textContent = displayName(msg) + " · " + (msg.type || msg.dev);
            caption.title = msg.circuit;
            extra.textContent = "";
            if (msg.type === "DS2438") {
                value.textContent = formatNumber(msg.temp, 1);
                unit.textContent = " °C";
                extra.textContent = "humidity " + formatNumber(msg.humidity, 1) + " %";
            } else if (msg.dev === "temp") {
                value.textContent = formatNumber(msg.value, 1);
                unit.textContent = typeof msg.value === "number" ? " °C" : "";
            } else {
                value.textContent = msg.value === null || msg.value === undefined ? "N/A" : String(msg.value);
                unit.textContent = "";
            }
        },
    };
}

function watchdogRow(msg) {
    const value = h("span", { class: "row-value" });
    const notes = h("span", { class: "note-holder" });
    const element = h(
        "div",
        { class: "row" },
        h("span", { class: "row-name" }, "Watchdog"),
        notes,
        value,
        gearButton(msg),
    );
    return {
        element,
        notes,
        update(msg) {
            value.textContent =
                (msg.value === 1 ? "Enabled, " + msg.timeout + " ms" : "Disabled") +
                (msg.was_wd_reset ? " · restarted by the watchdog" : "");
        },
    };
}

function modbusRow(msg) {
    const value = h("span", { class: "row-value" });
    const notes = h("span", { class: "note-holder" });
    const element = h("div", { class: "row" }, h("span", { class: "row-name" }, "Modbus scan"), notes, value);
    return {
        element,
        notes,
        update(msg) {
            value.textContent =
                (msg.scan_enabled === false ? "disabled" : "every " + msg.scan_interval + " s") +
                (msg.scan_error ? " · " + msg.scan_error : "");
        },
    };
}

// # The dialog of the configuration of a device

const TITLES = {
    di: "Digital input",
    do: "Digital output",
    ro: "Relay output",
    led: "User LED",
    ai: "Analog input",
    ao: "Analog output",
    wd: "Watchdog",
    temp: "1-Wire sensor",
    "1wdevice": "1-Wire device",
};

function field(label, input, hint) {
    const id = "config-" + input.name;
    input.id = id;
    return h(
        "div",
        { class: "field" },
        h("label", { for: id }, label),
        input,
        hint ? h("span", { class: "field-hint" }, hint) : null,
    );
}

function selectInput(name, options, selected) {
    return h(
        "select",
        { name: name },
        options.map(([value, label]) => h("option", { value: value, selected: value === selected }, label)),
    );
}

function numberInput(name, value, attrs) {
    return h(
        "input",
        Object.assign(
            { type: "number", name: name, value: value === null || value === undefined ? "" : value, step: "any" },
            attrs || {},
        ),
    );
}

// The fields of the params of a device type, named by the params of Evok
function configFields(msg) {
    const fields = [];
    switch (msg.dev) {
        case "ai":
        case "ao": {
            const modes = msg.modes || {};
            if (Object.keys(modes).length) {
                fields.push(
                    field(
                        "Mode",
                        selectInput(
                            "mode",
                            Object.entries(modes).map(([mode, info]) => [
                                mode,
                                info.unit && info.range
                                    ? mode + " (" + info.range[0] + " – " + info.range[1] + " " + info.unit + ")"
                                    : mode,
                            ]),
                            msg.mode,
                        ),
                    ),
                );
            }
            break;
        }
        case "do": {
            if (msg.pwm_freq !== null && msg.pwm_freq !== undefined) {
                // Evok sets the mode by the PWM duty cycle, PWM above 0 %, Simple at 0 %; the mode is not sent
                const mode = selectInput(
                    "mode",
                    (msg.modes || ["Simple", "PWM"]).map((mode) => [mode, mode]),
                    msg.mode,
                );
                mode.disabled = true;
                const duty = numberInput("pwm_duty", msg.pwm_duty, { min: 0, max: 100 });
                duty.addEventListener("input", () => {
                    mode.value = parseFloat(duty.value) > 0 ? "PWM" : "Simple";
                });
                fields.push(
                    field("Mode", mode, "Set by the PWM duty cycle: PWM above 0 %, Simple at 0 %"),
                    field("PWM frequency (Hz)", numberInput("pwm_freq", msg.pwm_freq, { min: 0 })),
                    field("PWM duty cycle (%)", duty),
                );
            }
            break;
        }
        case "di": {
            fields.push(field("Debounce (ms)", numberInput("debounce", msg.debounce, { min: 0, max: 65535 })));
            const modes = msg.modes || [];
            if (modes.length) {
                const mode = selectInput(
                    "mode",
                    modes.map((mode) => [mode, mode]),
                    msg.mode,
                );
                fields.push(field("Mode", mode));
                // the DirectSwitch mode is chosen together with the mode, shown and sent only with DirectSwitch
                if (modes.includes("DirectSwitch")) {
                    const dsField = field(
                        "DirectSwitch mode",
                        selectInput(
                            "ds_mode",
                            (msg.ds_modes || DS_MODES).map((mode) => [mode, mode]),
                            msg.ds_mode,
                        ),
                    );
                    dsField.hidden = msg.mode !== "DirectSwitch";
                    mode.addEventListener("change", () => {
                        dsField.hidden = mode.value !== "DirectSwitch";
                    });
                    fields.push(dsField);
                }
            }
            if (msg.counter !== null && msg.counter !== undefined && msg.counter_mode !== "Disabled") {
                fields.push(field("Counter", numberInput("counter", msg.counter, { min: 0, step: 1 })));
            }
            break;
        }
        case "wd": {
            fields.push(
                field(
                    "Command watchdog",
                    selectInput(
                        "value",
                        [
                            ["0", "Disabled"],
                            ["1", "Enabled"],
                        ],
                        String(msg.value),
                    ),
                    "Restarts the unit when it gets no command within the timeout",
                ),
                field("Timeout (ms)", numberInput("timeout", msg.timeout, { min: 0, max: 65535, step: 1 })),
            );
            break;
        }
    }
    // the alias of a watchdog is not used by the page
    if (msg.dev !== "wd") {
        fields.push(
            field(
                "Alias",
                h("input", {
                    type: "text",
                    name: "alias",
                    value: msg.alias ? aliasText(msg.alias) : "",
                    maxlength: 64,
                    pattern: "[A-Za-z0-9._\\- ]*",
                }),
                "Letters, digits, . _ - and spaces; empty removes the alias",
            ),
        );
    }
    return fields;
}

// The params of the form: the numbers as numbers, the hidden and disabled fields are not sent
function configParams(form) {
    const params = {};
    for (const input of form.elements) {
        if (!input.name || input.disabled || input.closest("[hidden]")) {
            continue;
        }
        if (input.name === "alias") {
            params.alias = aliasValue(input.value);
        } else if (input.type === "number" || input.name === "value") {
            if (input.value !== "") {
                params[input.name] = Number(input.value);
            }
        } else {
            params[input.name] = input.value;
        }
    }
    return params;
}

function openConfig(dev, circuit) {
    const msg = state.devices.get(keyOf(dev, circuit));
    if (!msg) {
        return;
    }
    const dialog = document.getElementById("config-dialog");
    const form = document.getElementById("config-form");
    const error = document.getElementById("config-error");
    document.getElementById("config-title").textContent = (TITLES[dev] || dev) + " " + displayName(msg);
    document.getElementById("config-subtitle").textContent = msg.alias ? circuitName(circuit) : "";
    document.getElementById("config-fields").replaceChildren(...configFields(msg));
    error.hidden = true;
    form.onsubmit = async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) {
            return;
        }
        try {
            const params = configParams(form);
            const reply = await api("/json/" + dev + "/" + circuit, params);
            if (reply && reply.result) {
                handleDevices([reply.result]);
            }
            dialog.close();
            // the PWM frequency is shared by a group of DOs, Evok sends the event of the set one only
            if (dev === "do" && "pwm_freq" in params) {
                api("/json/do/all")
                    .then(handleDevices)
                    .catch((error) => showError("Reading the digital outputs: ", error));
            }
        } catch (failure) {
            if (failure.status === 401) {
                dialog.close();
                return;
            }
            error.textContent = failure.message;
            error.hidden = false;
        }
    };
    dialog.showModal();
}

// # Saving and resetting of the units

// A dialog with the checkboxes of the units, all checked or none; extra are the other choices {value, label}
function openUnitsDialog(title, message, units, checked, extra, submitText, onSubmit) {
    const dialog = document.getElementById("units-dialog");
    const form = document.getElementById("units-form");
    document.getElementById("units-title").textContent = title;
    document.getElementById("units-message").textContent = message;
    document.getElementById("units-submit").textContent = submitText;
    const choices = units
        .sort(collator.compare)
        .map((unit) => ({ value: unit, label: unitName(unit) }))
        .concat(extra);
    const fieldset = document.getElementById("units-choices");
    fieldset.replaceChildren(
        fieldset.querySelector("legend"),
        ...choices.map((choice) =>
            h(
                "label",
                { class: "choice" },
                h("input", { type: "checkbox", name: "unit", value: choice.value, checked: checked }),
                choice.label,
            ),
        ),
    );
    form.onsubmit = (event) => {
        event.preventDefault();
        const chosen = [...fieldset.querySelectorAll("input:checked")].map((input) => input.value);
        if (!chosen.length) {
            return;
        }
        dialog.close();
        onSubmit(chosen);
    };
    dialog.showModal();
}

// The settings of a Modbus unit are saved by its device nv_save, the units without it are not listed
function openSaveDialog() {
    openUnitsDialog(
        "Save current state to Flash",
        "The units load the saved settings after their restart.",
        devicesOf("nv_save").map((msg) => msg.circuit),
        true,
        [{ value: SAVE_ALIASES, label: "Aliases of the devices" }],
        "Save",
        (chosen) => {
            for (const unit of chosen) {
                if (unit === SAVE_ALIASES) {
                    api("/json/run/alias", { save: 1 }).catch((error) => showError("Error saving aliases: ", error));
                } else {
                    api("/json/nv_save/" + unit, { value: 1 }).catch((error) =>
                        showError("Error saving FW data of " + unit + ": ", error),
                    );
                }
            }
        },
    );
}

// A unit is restarted by its watchdog
function openResetDialog() {
    openUnitsDialog(
        "Reset units",
        "The units restart at once, they do not respond until they start again.",
        devicesOf("wd").map((msg) => msg.circuit),
        false,
        [],
        "Reset",
        (chosen) => {
            for (const unit of chosen) {
                api("/json/wd/" + unit, { reset: 1 }).catch((error) =>
                    showError("Error resetting the unit " + unit + ": ", error),
                );
            }
        },
    );
}

// # The token

function openTokenDialog(message) {
    document.getElementById("token-message").textContent = message;
    document.getElementById("token-field").value = "";
    const dialog = document.getElementById("token-dialog");
    if (!dialog.open) {
        dialog.showModal();
    }
}

function requestToken() {
    if (state.authRequired) {
        return;
    }
    state.authRequired = true;
    setConnection("connecting");
    openTokenDialog(state.token ? "Evok refused the token." : "Evok requires a token.");
}

function setToken(token) {
    state.token = token;
    saveSetting("evok_token", token);
    state.authRequired = false;
    document.getElementById("token-dialog").close();
    // reconnect the WebSocket with the new token
    if (state.ws) {
        state.ws.close();
    } else {
        connectWebSocket();
    }
    loadAll();
}

// # The theme

function toggleTheme() {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    saveSetting("darkMode", dark ? "true" : "false");
}

// # Start

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("save-button").addEventListener("click", openSaveDialog);
    document.getElementById("reset-button").addEventListener("click", openResetDialog);
    document.getElementById("token-button").addEventListener("click", () => openTokenDialog(""));
    document.getElementById("theme-button").addEventListener("click", toggleTheme);
    document.getElementById("unit-select").addEventListener("change", (event) => selectUnit(event.target.value));
    document.getElementById("token-form").addEventListener("submit", (event) => {
        event.preventDefault();
        setToken(document.getElementById("token-field").value.trim());
    });
    document.getElementById("token-clear").addEventListener("click", () => setToken(""));
    for (const button of document.querySelectorAll("[data-close]")) {
        button.addEventListener("click", () => button.closest("dialog").close());
    }
    window.addEventListener("hashchange", () => {
        const unit = decodeURIComponent(location.hash.slice(1));
        if (unit && unit !== state.unit) {
            selectUnit(unit);
        }
    });
    loadVersion();
    connectWebSocket();
    loadAll();
});
