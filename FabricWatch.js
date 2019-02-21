const WebSocket = require('ws');
const logger = require('winston');

console.log(process.env.FABRIC_WATCH_LOGLEVEL);
if (process.env.FABRIC_WATCH_LOGLEVEL) {
    logger.level = process.env.FABRIC_WATCH_LOGLEVEL;
}

const FabricWatch = class {
    constructor(channel, endpoints) {
        logger.debug('Creating a new Fabric Watch object for %s %s', channel.getName(), endpoints);
        this._channel = channel;
        this._txTable = new Map();
        if (Array.isArray(endpoints)) {
            this._endpoints = endpoints;
        } else {
            this._endpoints = [endpoints];
        }
        this._servers = new Set();
        this._txTable = new Map();
        this._peers = new Map();
        this._index = 0;
    }

    async connect() {
        const watch = this;

        const massageHander = response => {
            logger.debug('message from server: %j', response);
            const messages = JSON.parse(response);

            for (const msg of messages) {
                if (msg.msgType == 'blockEvent') {
                    const height = msg.number;
                    const name = msg.peer;
                    const mspid = msg.mspid;
                    const peer = watch._peers.get(name);

                    if (peer !== undefined) {
                        peer.height = height;
                    } else {
                        const channelPeer = watch._channel.getPeer(name);
                        if (channelPeer !== undefined) {
                            const newPeer = {
                                channelPeer: channelPeer,
                                mspid: mspid,
                                height: height
                            };
                            logger.debug('Registering new peer %s %s %d', name, newPeer.mspid, newPeer.height);
                            watch._peers.set(name, newPeer);

                        }
                    }
                } else if (msg.msgType == 'txEvent') {
                    const name = msg.peer;
                    const reg = watch._txTable.get(msg.txid);
                    if (reg !== undefined) {
                        watch._txTable.delete(msg.txid);
                        logger.debug('Callding event handler for %s', msg.txid);
                        reg.onEvent(msg.txid, msg.tx_validation_code, watch._peers.get(name).height);
                    }
                } else {
                    logger.info('Unknown message msgType %s. Ignoring', msg.type);
                }
            };
        };

        let firstMessageHandler;
        const firstMessagePromise = new Promise((resolve, reject) => {
            firstMessageHandler = (response) => {
                logger.debug('firstMessageHandler is called');
                massageHander(response);
                resolve();
            };
        });

        const connectionPromises = [];
        for (const endpoint of this._endpoints) {
            logger.debug('Connecting to a Fabric Watch server: %s', endpoint);
            let url = endpoint;
            if (!endpoint.startsWith("ws://")) {
                url = "ws://" + endpoint;
            }
            const socket = new WebSocket(url);
            connectionPromises.push(new Promise(resolve => {
                socket.on('open', () => {
                    logger.debug('Connected to a Fabric Watch server: %s', url);
                    resolve()
                });
                socket.on('message', firstMessageHandler);
            }));
            this._servers.add(socket);
        }
        await Promise.all(connectionPromises);
        await firstMessagePromise;

        for (const socket of this._servers) {
            socket.on('message', massageHander);
        }

        logger.debug('Message handlers are set');
    }

    async close() {
        const closePromises = []
        for (const socket of this._servers) {
            closePromises.push(new Promise((resolve, reject) => {
                socket.on('close', resolve);
            }));
            socket.close();
        }
        await Promise.all(closePromises);
        for (const reg of this._txTable.values()) {
            reg.onError('Connection closed');
        }
    }

    async registerTxEvent(txid, onEvent, onError, options) {
        logger.debug('registerTxEvent is called');
        this._txTable.set(txid, {
            onEvent: onEvent,
            onError: onError,
            options: options
        });
        const cmd = {
            command: 'register',
            txid: txid
        };
        const promises = [];
        for (const socket of this._servers) {
            promises.push(new Promise((resolve, reject) => {
                logger.debug('Sending a command to a server %s:', socket.url, cmd);
                socket.send(JSON.stringify(cmd), null, resolve);
            }));
        }
        await Promise.all(promises);
        // FIXME: We need to confirm completion of registration
        return txid;
    }

    async unregisterTxEvent(block_registration_number, throwError) {
        this._txTable.delete(txid);
        const cmd = {
            command: 'unregister',
            txid: block_registration_number
        };
        const promises = [];
        for (const socket of this._servers) {
            socket.send(JSON.stringify(cmd));
        }
        await Promise.all(promises);
        return txid;
    }

    getTargetPeers(targetOrgMSPIDs) {
        logger.debug('getTargetPeers is called targetOrgMSPs=%j', targetOrgMSPIDs)
        let subset = null;
        if (targetOrgMSPIDs) {
            subset = new Set(targetOrgMSPIDs);
        }
        const candidates = new Map();

        for (const [name, peer] of this._peers.entries()) {
            if (!subset || subset.has(peer.mspid)) {
                const c = candidates.get(peer.mspid);
                if (c === undefined || peer.number > c[0].number) {
                    candidates.set(peer.mspid, [peer]);
                } else if (peer.number === c[0].number) {
                    c.push(peer);
                }
            }
        }

        const target = [];

        for (const orgPeers of candidates.values()) {
            target.push(orgPeers[this._index % orgPeers.length].channelPeer);
        }

        this._index += 1;

        return target;
    }
}

module.exports = FabricWatch
