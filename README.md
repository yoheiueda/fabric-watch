# Fabric Watch

Fabric Watch is a small server program that monitors multiple peer event sources, and provides clients with channel events as well as block heights and peer availability.

Fabric peer provides event notification mechanism called ChannelEventHub, and clients can connect to ChannelEventHub to get notifications of channel events such as transaction completion and block generation. When the number of ChannelEventHub connections to a single peer procees becomes large, the throughput performance of peer tends to degrade.

Usually, Node.js process is single-threaded, and need to launch multiple Node.js processes to utilize multiple cores on a machine. In this situation, a ChannelEventHub connection is necessary per Node.jsprocess, and large-scale deployment of Fabric clients suffers from the performacne issue of ChannelEventHub.

To work around this performance problem, a Fabric Watch server process establishes a ChannelEventHub connection to each peer processes, and accepts event notification requests from clients.  When the Fabric Watch server recieves channel event from peer via ChannelEventHub, it forwards the event to a appropreate client.  With this approach, we can reduce the necessary number of ChannelEventHub connections to each peer.

## Set up instructions

```
git clone https://github.com/yoheiueda/fabric-watch
cd fabric-watch
npm install
```
## Start a Fabric Watch server
To start a Fabric Watch server program, you need a valid conenction profile that contains a organization definition with admin's certificate and private key. Fabric Watch server tries to connect all peers defined in connection profile using admin's credentail of an organization specified in a command line argument.
```
node server/fabric-watch-server.js --profile ./connection-profile.yaml --org org1 --port 10001
```

You can start multiple Fabric Watch processes on different machines to keep high availability.

## Use Fabric Watch from client

The following code snipt shows how to use Fabric Watch in a Fabric Client program.

```
const FabricWatch = require('./FabricWatch.js');
const watch = new FabricWatch(channel, ['host1:10001', 'host2:10002']);
await watch.connect();

const txid = client.newTransactionID();

const results = await channel.sendTransactionProposal({
        target: watch.getTargetPeers()
        chaincodeId: 'mychaincode',
        fcn: 'myfunc',
        txId: txid
});

await watch.registerTxEvent(txid.getTransactionID(), (txid, code) => {
    console.log('tx id:%s code:%s', txid, code);
});

await channel.sendTransaction({
        txId: txid,
        proposalResponses: results[0],
        proposal: results[1]
});
```
The FabricWatch object constructor accepts a channel object as well as endpoints to Fabric Watch servers.  `watch.connect()` establishes a connection to each of specified Fabric Watch server endpoints.

`watch.getTargetPeers()` returns a array of `ChannelPeer` objects. The array contains a peer per organization, and each peer in the array has the largest block height among peers in the same organization.

`watch.registerTxEvent` can be used to register an event handler in a similar way to ChannelEventHub.

The event handler is called when one of the specified Fabric Watch servers sends notification for the first time.  Second or later notifications of the same event comming from the remaining Fabric Watch servers are just ignored.
