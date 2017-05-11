const CON_PREFIX = '\x1b[33m[BTDevicelink]\x1b[0m';

var express = require('express');
var bodyParser = require('body-parser');
var co = require('co');
var wrap = require('co-express');
var promisify = require('es6-promisify');
var fs = require('fs');
var Path = require('path');
var app = require('express')();
var server = require('http').Server(app);
var io = require('socket.io')(server);

app.use(express.static(__dirname + '/public'));
app.set('view engine', 'html');
app.set('views', __dirname + '/views');
app.engine('html', require('hbs').__express);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

module.exports = function start(devices, ble, deviceDb, clientService) {

function mapState(state) {
    switch (state) {
        case 'connecting':
            return 'Connecting';
        case 'disconnected':
            return 'Disconnected';
        case 'discovering-characteristics':
            return 'Discovering characteristics';
        case 'discovering-services':
            return 'Discovering services';
        case 'reading-characteristics':
            return 'Reading characteristics';
        case 'connected':
            return 'Connected';
        case 'connection-failed':
            return 'Connection failed';
        default:
            return state;
    }
}

function stringifyGatt(gatt) {
    return gatt ? '{\n' + Object.keys(gatt).map(sk => {
        return `    "${sk}": {\n` + Object.keys(gatt[sk]).map(ck => {
            if (!gatt[sk][ck]) return undefined;
            return `        "${ck}": [ ${gatt[sk][ck].value.join(', ')} ]`;
        }).join(',\n') + '\n    }';
    }).join(',\n') + '\n}' : '{}';
}

app.get('/', wrap(function*(req, res) {

    let model = Object.keys(devices).map(address => {
        let d = devices[address];
        let state = (d.state === 'connected' ? '\u2713' : mapState(d.state));
        let stateError = d.stateError ? ' - ' + d.stateError : '';

        return {
            deveui: d.address,
            title: d.address + ` (${ble.getLocalName(d.address) || 'Unknown'})`,
            localName: ble.getLocalName(d.address) || '',
            endpoint: d.cloudDefinition.security.mbed_endpoint_name,
            state: state,
            stateError: stateError,
            notConnected: d.state !== 'connected',
            error: d.error
        };
    });

    res.render('index.html', {
        endpoints: model,
        deleted: (req._parsedUrl.query || '').indexOf('deleted') > -1
    });
}));

app.get('/device/:deveui', wrap(function*(req, res, next) {
    let device = devices[req.params.deveui];

    var address = req.params.deveui;
    var read = '{\n    ' + Object.keys(device.cloudDefinition.read).map(k => {
        return `"${k}": ${device.cloudDefinition.read[k].toString()}`;
    }).join(',\n    ') + '\n}';
    var write = '{\n    ' + Object.keys(device.cloudDefinition.write).map(k => {
        return `"${k}": ${device.cloudDefinition.write[k].toString()}`;
    }).join(',\n    ') + '\n}';

    var lwm2m = (device && device.lwm2m) ? Object.keys(device.lwm2m).reduce((curr, k) => {
        curr[k] = device.lwm2m[k].defaultValue;
        return curr;
    }, {}) : null;

    var gatt = (ble.getDevice(address) || {}).model;

    // stringify gatt myself...
    var gatt_str = gatt ? stringifyGatt(gatt) : JSON.stringify({});

    var model = {
        deveui: address,
        endpoint: device.cloudDefinition.security.mbed_endpoint_name,
        localName: ble.getLocalName(address) || 'Unknown',
        state: mapState(device.state),
        stateError: device.stateError ? (' - ' + device.stateError) : '',
        read: read,
        write: write,
        saved: !device.error && (req._parsedUrl.query || '').indexOf('saved') > -1,
        created: !device.error && (req._parsedUrl.query || '').indexOf('created') > -1,
        error: device.error,
        gatt: gatt_str,
        lwm2m: lwm2m ? JSON.stringify(lwm2m, null, 4) : 'Waiting for connection...',
        unconfigured: (Object.keys(device.cloudDefinition.read).length === 1 &&
            Object.keys(device.cloudDefinition.read)[0] === 'example/0/rule') ? 'unconfigured' : '',
        mbed_type: device.cloudDefinition.security.mbed_type || ''
    };

    res.render('device.html', model);
}));

app.post('/device/:deveui/update', wrap(function*(req, res) {
    let d = devices[req.params.deveui].cloudDefinition;

    if (req.body.mbed_type) {
        d.security.mbed_type = req.body.mbed_type;
    }

    d.read = '1PLACEHOLDER';
    d.write = '2PLACEHOLDER';

    var data = (JSON.stringify(d, null, 4));

    data = data.replace('"1PLACEHOLDER"', req.body.read);
    data = data.replace('"2PLACEHOLDER"', req.body.write);

    data = 'module.exports = ' + data + ';';

    yield deviceDb.saveDevice(req.params.deveui, data);

    res.redirect('/device/' + req.params.deveui + '?saved');
}));

app.post('/device/:deveui/delete', wrap(function*(req, res) {
    var p = Path.join(__dirname, '../devices', req.params.deveui + '.js');
    yield deviceDb.deleteDevice(req.params.deveui);

    res.redirect('/?deleted');
}));

app.get('/new-device', wrap(function*(req, res, next) {
    res.render('new-device.html', {});
}));

app.post('/new-device', wrap(function*(req, res, next) {
    // add the device in mbed Client Service
    try {
        console.log(CON_PREFIX, 'Creating new device in mbed-client-service');

        var clientDevice = yield clientService.createConnectorDevice(req.body.connector_domain,
            req.body.connector_ak,
            'test',
            [
                { path: '/example/0/rule', value: 'Hello world', valueType: 'dynamic', operation: ['GET', 'PUT'], observable: true }
            ]);
    }
    catch (ex) {
        console.error(CON_PREFIX, 'Creating device in mbed-client-service failed', ex);
        throw 'Creating device in mbed-client-service failed, ' + ex.message;
    }

    console.log(CON_PREFIX, 'Created new device in mbed-client-service');

    var file = JSON.stringify({
        type: 'create-device',
        deveui: req.body.eui,
        security: {
            mbed_endpoint_name: clientDevice.id,
            mbed_domain: req.body.connector_domain,
            access_key: req.body.connector_ak,
        },
        read: {
            "example/0/rule": "1PLACEHOLDER"
        },
        write: {
            "example/0/rule": "2PLACEHOLDER"
        }
    }, null, 4);

    file = file.replace('"1PLACEHOLDER"', 'function (m) {\n' +
        "        // read characteristics like: m['180a']['2a29'].toString('ascii'))\n" +
        "        return 'Hello world';\n" +
        "    }");
    file = file.replace('"2PLACEHOLDER"', 'function (value, write) {\n' +
        "        // write characteristics like: write('180a/2a29', [ 0x10, 0x30 ])\n" +
        "        // note: value is string\n" +
        "    }");

    file = 'module.exports = ' + file + ';';

    yield deviceDb.saveNewDevice(req.body.eui, file);

    devices[req.body.eui] = yield deviceDb.loadDevice(req.body.eui);

    res.redirect('/device/' + req.body.eui + '?created');
}));

app.get('/known-services.js', wrap(function*(req, res, next) {
    var base = Path.join(__dirname, 'public', 'known-services');
    var all = yield promisify(fs.readdir.bind(fs))(base);

    // always put known-services.js at the bottom
    all = all.filter(a => a !== 'known-services.js');
    all.unshift('known-services.js');

    var files = yield Promise.all(all.map(path => promisify(fs.readFile.bind(fs))(Path.join(base, path), 'utf-8')));

    res.set('Content-Type', 'text/javascript');
    res.send(files.join('\n'));
}));


io.on('connection', socket => {
    socket.on('subscribe', function(eui) {
        if (!devices[eui]) return;

        socket.emit('statechange', mapState(devices[eui].state), '');
        socket.emit('modelchange', stringifyGatt((ble.getDevice(eui) || {}).model));
        socket.emit('lwm2mchange', JSON.stringify(devices[eui].lwm2m, null, 4));

        var sc, mc, lc, ln;

        devices[eui].on('statechange', sc = function(state, error) {
            socket.emit('statechange', mapState(state), error && error.toString());
        });
        devices[eui].on('ble-model-updated', mc = function(model) {
            socket.emit('modelchange', stringifyGatt(model));
        });
        devices[eui].on('localnamechange', ln = function(name) {
            socket.emit('localnamechange', name);
        });

        // @todo, lwm2mchange is no longer there...
        devices[eui].on('lwm2mchange', lc = function(model) {
            socket.emit('lwm2mchange', JSON.stringify(model, null, 4));
        });

        socket.on('disconnect-device', () => {
            if (devices[eui] && devices[eui].peripheral) {
                devices[eui].peripheral.disconnect();
            }
        });

        socket.on('disconnect', () => {
            try {
                devices[eui].removeListener('statechange', sc);
                devices[eui].removeListener('ble-model-updated', mc);
                devices[eui].removeListener('lwm2mchange', lc);
                devices[eui].removeListener('localnamechange', ln);
            } catch (ex) {}
        });
    });

    socket.on('subscribe-seen', function() {
        var s;
        ble.on('seen', s = function(dev) {
            socket.emit('seen', dev);
        });
        socket.on('disconnect', () => {
            try {
                ble.removeListener(s);
            } catch(ex) { /*whatever*/ }
        });
    });
});

server.listen(process.env.PORT || 3000, process.env.IP || '0.0.0.0', function () {
    console.log(CON_PREFIX, 'Web server listening on port ' + (process.env.PORT || 3000) + '!');
});

};
