const http = require('http');
const { v4: uuidV4 } = require('uuid');
const express = require('express');
// const http2Express = require('http2-express-bridge')

const morgan = require('morgan');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cors = require('cors')

const https = require('node:https');
const http2 = require('node:http2');
const fs = require('node:fs');
const options = {
  key: fs.readFileSync('localhost-privkey.pem'),
  cert: fs.readFileSync('localhost-cert.pem'),
};


process.env.JWT_GENERATOR_USERNAME = 'aa'
process.env.JWT_GENERATOR_PASSWORD = 'bb'

process.env.SECRET_KEY = 'aa'


require('dotenv').config();

const { TunnelRequest, TunnelResponse } = require('./lib');
const { Stream } = require('stream');

const app = express();
// const app = http2Express(express)

const httpServer = http.createServer(app);
// const httpServer = https.createServer(options, app);  // test ok: curl -k https://localhost:8080/__txt
// const httpServer = http2.createServer(options, app);  // test not ok: curl -k https://localhost:8080/__txt
const webTunnelPath = '/$web_tunnel';
const io = new Server(httpServer, {
  path: webTunnelPath,
});

let tunnelSockets = [];

function getTunnelSocket(host, pathPrefix) {
  return tunnelSockets.find((s) =>
    s.host === host && s.pathPrefix === pathPrefix
  );
}

function setTunnelSocket(host, pathPrefix, socket) {
  tunnelSockets.push({
    host,
    pathPrefix,
    socket,
  });
}

function removeTunnelSocket(host, pathPrefix) {
  tunnelSockets = tunnelSockets.filter((s) =>
    !(s.host === host && s.pathPrefix === pathPrefix)
  );
  console.log('tunnelSockets: ', tunnelSockets);
}

function getAvailableTunnelSocket(host, url) {
  const tunnels = tunnelSockets.filter((s) => {
    if (s.host !== host) {
      return false;
    }
    if (!s.pathPrefix) {
      return true;
    }
    return url.indexOf(s.pathPrefix) === 0;
  }).sort((a, b) => {
    if (!a.pathPrefix) {
      return 1;
    }
    if (!b.pathPrefix) {
      return -1;
    }
    return b.pathPrefix.length - a.pathPrefix.length;
  });
  if (tunnels.length === 0) {
    return null;
  }
  return tunnels[0].socket;
}

io.use((socket, next) => {
  const connectHost = socket.handshake.headers.host;
  const pathPrefix = socket.handshake.headers['path-prefix'];
  if (getTunnelSocket(connectHost, pathPrefix)) {
    return next(new Error(`${connectHost} has a existing connection`));
  }
  if (!socket.handshake.auth || !socket.handshake.auth.token) {
    next(new Error('Authentication error'));
  }
  jwt.verify(socket.handshake.auth.token, process.env.SECRET_KEY, function (err, decoded) {
    if (err) {
      return next(new Error('Authentication error'));
    }
    if (decoded.token !== process.env.VERIFY_TOKEN) {
      return next(new Error('Authentication error'));
    }
    next();
  });
});

io.on('connection', (socket) => {
  const connectHost = socket.handshake.headers.host;
  const pathPrefix = socket.handshake.headers['path-prefix'];
  setTunnelSocket(connectHost, pathPrefix, socket);
  console.log(`client connected at ${connectHost}, path prefix: ${pathPrefix}`);
  const onMessage = (message) => {
    if (message === 'ping') {
      socket.send('pong');
    }
  }
  const onDisconnect = (reason) => {
    console.log('client disconnected: ', reason);
    removeTunnelSocket(connectHost, pathPrefix);
    socket.off('message', onMessage);
  };
  socket.on('message', onMessage);
  socket.once('disconnect', onDisconnect);
});

app.use(cors())

app.use(morgan('tiny'));
app.get('/__img', (req, res) => {
  res.sendFile(__dirname + '/sunrise.jpg');
})
app.get('/__txt', (req, res) => {
  res.send('txt')
})

app.post('/__json', async (req, res) => {
  const reader = Stream.Readable.toWeb(req).getReader()

  let body = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    body.push(value);
    console.log('Received', value, value.toString());
  }

  body = Buffer.concat(body).toString();
  console.log('Response fully received:', body);
  res.send('got posted data: ' + body)
})


app.post('/__stream', async (req, res) => {

  const reader = Stream.Readable.toWeb(req).getReader()

  let body = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    body.push(value);
    console.log('Received', value, value.toString());
  }

  body = Buffer.concat(body).toString();
  console.log('Response fully received:', body);
  res.send('server got: ' + body)

  return


  // 以下方式也可以读取数据
  // // https://nodejs.org/en/docs/guides/anatomy-of-an-http-transaction
  // req
  //   .on('data', chunk => {
  //     body.push(chunk);
  //     console.log('Received', chunk, chunk.toString());
  //   })
  //   .on('end', () => {
  //     body = Buffer.concat(body).toString();
  //     // at this point, `body` has the entire request body stored in it as a string

  //     console.log('req fully received, content is:', body);
  //     res.send('got: ' + body)
  //   });
})

app.get('/tunnel_jwt_generator', (req, res) => {
  if (!process.env.JWT_GENERATOR_USERNAME || !process.env.JWT_GENERATOR_PASSWORD) {
    res.status(404);
    res.send('Not Found.');
    return;
  }
  if (
    req.query.username === process.env.JWT_GENERATOR_USERNAME &&
    req.query.password === process.env.JWT_GENERATOR_PASSWORD
  ) {
    const jwtToken = jwt.sign({ token: process.env.VERIFY_TOKEN }, process.env.SECRET_KEY);
    res.status(200);
    res.send(jwtToken);
    return;
  }
  res.status(401);
  res.send('Forbidden');
});

function getReqHeaders(req) {
  const encrypted = !!(req.isSpdy || req.connection.encrypted || req.connection.pair);
  const headers = { ...req.headers };
  const url = new URL(`${encrypted ? 'https' : 'http'}://${req.headers.host}`);
  const forwardValues = {
    for: req.connection.remoteAddress || req.socket.remoteAddress,
    port: url.port || (encrypted ? 443 : 80),
    proto: encrypted ? 'https' : 'http',
  };
  ['for', 'port', 'proto'].forEach((key) => {
    const previousValue = req.headers[`x-forwarded-${key}`] || '';
    headers[`x-forwarded-${key}`] =
      `${previousValue || ''}${previousValue ? ',' : ''}${forwardValues[key]}`;
  });
  headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
  return headers;
}

app.use('/', (req, res) => {
  const tunnelSocket = getAvailableTunnelSocket(req.headers.host, req.url);
  if (!tunnelSocket) {
    res.status(404);
    res.send('Not Found');
    console.log('getAvailableTunnelSocket Not Found')
    return;
  }
  const requestId = uuidV4();
  const tunnelRequest = new TunnelRequest({
    socket: tunnelSocket,
    requestId,
    request: {
      method: req.method,
      headers: getReqHeaders(req),
      path: req.url,
    },
  });
  const onReqError = (e) => {
    tunnelRequest.destroy(new Error(e || 'Aborted'));
  }
  req.once('aborted', onReqError);
  req.once('error', onReqError);
  req.pipe(tunnelRequest);
  req.once('finish', () => {
    req.off('aborted', onReqError);
    req.off('error', onReqError);
  });
  const tunnelResponse = new TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });
  const onRequestError = () => {
    tunnelResponse.off('response', onResponse);
    tunnelResponse.destroy();
    res.status(502);
    res.end('Request error');
  };
  const onResponse = ({ statusCode, statusMessage, headers }) => {
    tunnelRequest.off('requestError', onRequestError)
    res.writeHead(statusCode, statusMessage, headers);
  };
  tunnelResponse.once('requestError', onRequestError)
  tunnelResponse.once('response', onResponse);
  tunnelResponse.pipe(res);
  const onSocketError = () => {
    res.off('close', onResClose);
    res.end(500);
  };
  const onResClose = () => {
    tunnelSocket.off('disconnect', onSocketError);
  };
  tunnelSocket.once('disconnect', onSocketError)
  res.once('close', onResClose);
});

function createSocketHttpHeader(line, headers) {
  return Object.keys(headers).reduce(function (head, key) {
    var value = headers[key];

    if (!Array.isArray(value)) {
      head.push(key + ': ' + value);
      return head;
    }

    for (var i = 0; i < value.length; i++) {
      head.push(key + ': ' + value[i]);
    }
    return head;
  }, [line])
    .join('\r\n') + '\r\n\r\n';
}

httpServer.on('upgrade', (req, socket, head) => {
  debugger
  if (req.url.indexOf(webTunnelPath) === 0) {
    return;
  }
  console.log(`WS ${req.url}`);
  // proxy websocket request
  const tunnelSocket = getAvailableTunnelSocket(req.headers.host, req.url);
  if (!tunnelSocket) {
    return;
  }
  if (head && head.length) socket.unshift(head);
  const requestId = uuidV4();
  const tunnelRequest = new TunnelRequest({
    socket: tunnelSocket,
    requestId,
    request: {
      method: req.method,
      headers: getReqHeaders(req),
      path: req.url,
    },
  });
  req.pipe(tunnelRequest);
  const tunnelResponse = new TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });
  const onRequestError = () => {
    tunnelResponse.off('response', onResponse);
    tunnelResponse.destroy();
    socket.end();
  };
  const onResponse = ({ statusCode, statusMessage, headers, httpVersion }) => {
    tunnelResponse.off('requestError', onRequestError);
    if (statusCode) {
      socket.once('error', (err) => {
        console.log(`WS ${req.url} ERROR`);
        // ignore error
      });
      // not upgrade event
      socket.write(createSocketHttpHeader(`HTTP/${httpVersion} ${statusCode} ${statusMessage}`, headers));
      tunnelResponse.pipe(socket);
      return;
    }
    const onSocketError = (err) => {
      console.log(`WS ${req.url} ERROR`);
      socket.off('end', onSocketEnd);
      tunnelSocket.off('disconnect', onTunnelError);
      tunnelResponse.destroy(err);
    };
    const onSocketEnd = () => {
      console.log(`WS ${req.url} END`);
      socket.off('error', onSocketError);
      tunnelSocket.off('disconnect', onTunnelError);
      tunnelResponse.destroy();
    };
    const onTunnelError = () => {
      socket.off('error', onSocketError);
      socket.off('end', onSocketEnd);
      socket.end();
      tunnelResponse.destroy();
    };
    socket.once('error', onSocketError);
    socket.once('end', onSocketEnd);
    tunnelSocket.once('disconnect', onTunnelError);
    socket.write(createSocketHttpHeader('HTTP/1.1 101 Switching Protocols', headers));
    tunnelResponse.pipe(socket).pipe(tunnelResponse);
  }
  tunnelResponse.once('requestError', onRequestError)
  tunnelResponse.once('response', onResponse);
});

process.env.PORT = 8080
httpServer.listen(process.env.PORT || 3000, '0.0.0.0');
console.log(`app start at port: ${process.env.PORT || 3000}`);
