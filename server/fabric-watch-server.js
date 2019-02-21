
const WebSocket = require('ws');
const sdk = require('fabric-client');

const program = require('commander');
const fs = require('fs');
const path = require('path');
const sprintf = require('sprintf-js').sprintf;
const yaml = require('js-yaml');

const logger = require('winston');
if (process.env.FABRIC_WATCH_LOGLEVEL) {
    logger.level = process.env.FABRIC_WATCH_LOGLEVEL;
}

function loadFile(filePath, baseDir) {
    if (!path.isAbsolute(filePath) && baseDir !== undefined) {
        filePath = path.join(baseDir, filePath);
    }
    return fs.readFileSync(filePath, 'utf8');
}

class MemoryKeyValueStore {
    constructor(options) {
        const self = this;
        logger.debug('MemoryKeyValueStore: constructor options=%j', options);
        self._store = new Map();
        return Promise.resolve(self);
    }

    getValue(name) {
        const value = Promise.resolve(this._store.get(name));
        logger.debug('MemoryKeyValueStore: getValue name=%j value=%j', name, value);
        return value;
    }

    setValue(name, value) {
        this._store.set(name, value);
        logger.debug('MemoryKeyValueStore: setValue name=%j value=%j', name, value);
        return Promise.resolve(value);
    }
}

async function getClient(profile, orgName) {
    const cryptoSuite = sdk.newCryptoSuite();
    const cryptoKeyStore = sdk.newCryptoKeyStore(MemoryKeyValueStore, {})
    cryptoSuite.setCryptoKeyStore(cryptoKeyStore);

    const client = sdk.loadFromConfig(profile);

    client.setCryptoSuite(cryptoSuite);
    const newStore = await new MemoryKeyValueStore();
    client.setStateStore(newStore);

    const org = profile.organizations[orgName];

    const userOpts = {
        username: "admin",
        mspid: org.mspid,
        //cryptoContent: { signedCertPEM: org.signedCert.pem, privateKeyPEM: org.adminPrivateKey.pem },
        cryptoContent: { signedCert: org.signedCert.path, privateKey: org.adminPrivateKey.path },
        skipPersistence: false
    };

    const user = await client.createUser(userOpts);

    return client;
}


class FabricWatchServer {
    constructor(channel) {
        this._channel = channel;
        this._connectedClients = new Set();
        this._watchingPeers = new Map();
        this._txWaiterTable = new Map();
    }

    async start(options) {
        const server = this;

        for (const channelPeer of server._channel.getPeers()) {
            if (channelPeer.isInRole('endorsingPeer') && channelPeer.isInRole('eventSource')) {
                const name = channelPeer.getName();
                const eventhub = channelPeer.getChannelEventHub();
                const peer = {
                    channelPeer: channelPeer,
                    eventhub: eventhub,
                    height: -1
                };
                this._watchingPeers.set(name, peer);

                // Set up block event listeners

                peer.blockRegNum = eventhub.registerBlockEvent(
                    block => {
                        logger.debug('Recieved a block [%d] from %s', block.number, name);
                        const buffers = new Map();

                        peer.height = block.number;

                        for (const socket of server._connectedClients.values()) {
                            if (socket.readyState !== WebSocket.OPEN) {
                                logger.debug('Connection becomes closed during block processing');
                            }
                            const message = {
                                msgType: 'blockEvent',
                                peer: name,
                                channel_id: block.channel_id,
                                number: block.number,
                                mspid: peer.channelPeer.getMspid()
                            }
                            buffers.set(socket, [message]);
                        }

                        for (const tx of block.filtered_transactions) {
                            const waiters = server._txWaiterTable.get(tx.txid);
                            if (waiters === undefined) {
                                logger.debug('Did not find waiters for %s', tx.txid);
                                continue;
                            }
                            logger.debug('Found waiters for %s', tx.txid);

                            for (const [socket, state] of waiters.entries()) {
                                if (socket.readyState !== WebSocket.OPEN) {
                                    logger.debug('Connection becomes closed with pending event registration');
                                    waiters.delete(socket);
                                    continue;
                                }
                                logger.debug('Waiter %s: %j', socket, state);
                                if (state.count !== undefined) {
                                    state.peers.delete(peer);
                                    state.count -= 1;
                                }
                                if (state.count === undefined || state.peers.size <= state.count) {

                                    waiters.delete(socket);
                                    let messages = buffers.get(socket);
                                    if (messages === undefined) {
                                        messages = [];
                                        buffers.set(socket, messages);
                                    }
                                    const message = {
                                        msgType: 'txEvent',
                                        peer: name,
                                        txid: tx.txid,
                                        type: tx.type,
                                        tx_validation_code: tx.tx_validation_code
                                    }
                                    messages.push(message);
                                    logger.debug('Responding %s with %j', tx.txid, message);
                                }
                            }
                            if (waiters.size == 0) {
                                server._txWaiterTable.delete(tx.txid);
                            }
                        }

                        for (const [socket, messages] of buffers.entries()) {
                            if (socket.readyState === WebSocket.OPEN) {
                                socket.send(JSON.stringify(messages));
                            } else {
                                logger.debug('Connection becomes closed with pending messages');
                            }
                        }

                        logger.debug('%d pending event registrations after processin a block [%d] from %s', server._txWaiterTable.size, block.number, name);
                    },
                    error => {
                        throw new Error('EventHub error ', error);
                    }
                );
            }
        }

        // Establish connections to peer event sources
        const connectionPromises = [];
        for (const peer of server._watchingPeers.values()) {
            peer.eventhub = peer.channelPeer.getChannelEventHub();
            connectionPromises.push(new Promise((resolve, reject) => {
                peer.eventhub.connect(false, (error, value) => {
                    if (error) {
                        reject(error);
                    } else {
                        logger.debug('Connected to a peer event source');
                        resolve(value);
                    }
                });
            }));
        }
        await Promise.all(connectionPromises);

        // Start a WebSocket server
        console.log('Listen on %d', options.port);
        const socketServer = new WebSocket.Server(options);
        socketServer.on('connection', socket => {
            logger.debug('Connected from a client');
            server._connectedClients.add(socket);

            const buffers = [];
            for (const [name, peer] of server._watchingPeers.entries()) {
                const message = {
                    msgType: 'blockEvent',
                    peer: name,
                    channel_id: this._channel.getName(),
                    number: peer.height,
                    mspid: peer.channelPeer.getMspid()
                }
                buffers.push(message);
            }
            logger.debug('sending first messages: %j', buffers);
            socket.send(JSON.stringify(buffers));

            socket.on('close', (code, reason) => {
                logger.debug('Connection is closed');
                server._connectedClients.delete(socket);
            });
            socket.on('message', msg => {
                const request = JSON.parse(msg);
                logger.debug('received: %j', request);

                switch (request.command) {
                    case 'register':
                        let txid = request.txid;
                        const state = {};
                        state.peers = new Set();
                        if (request.threshold !== undefined && request.peers !== undefined) {
                            for (const name of request.peers) {
                                const peer = server._watchingPeers.get(name);
                                if (peer == undefined) {
                                    // Error check
                                }
                                state.peers.add(peer);
                            }
                            state.count = state.peers.size - request.threshold + 1;
                        }
                        let waiters = server._txWaiterTable.get(txid);
                        if (waiters === undefined) {
                            waiters = new Map();
                            server._txWaiterTable.set(txid, waiters);
                            logger.debug('txWaiterTable is set for txid:%s from ', txid)
                        }
                        waiters.set(socket, state);
                        logger.debug('waiter state is added for txid:%s from: %j ', txid, state);
                        break;
                    case 'unregister':
                        txid = request.txid;
                        waiters = server._txWaiterTable.get(txid);
                        waiters.delete(socket);
                        if (waiters.size == 0) {
                            server._txWaiterTable.delete(txid);
                        }
                        break;
                }
            });
        });
    }
}

async function main() {

    program.option('--profile [path]', "Connection profile")
        .option('--channelID [channel]', 'Channel name')
        .option('--org [string]', "Organization name")
        .option('--port [number]', "Listen port")
        .option('--service-discovery', "Enable service discovery")
        .parse(process.argv);

    const profile = yaml.safeLoad(loadFile(program.profile));
    const client = await getClient(profile, program.org);
    const channel = client.getChannel(program.channelID);

    if (program.serviceDiscovery) {
        await channel.initialize({ discover: true });
    }

    const port = Number(program.port);

    const server = new FabricWatchServer(channel);

    await server.start({ port: port });
}

main().catch(error => {
    console.error(error);
});
