const http = require('http');
const https = require('https');

const server = http.createServer((clientReq, clientRes) => {
  const targetUrl = 'https://repo.maven.apache.org' + clientReq.url;
  
  https.get(targetUrl, { rejectUnauthorized: false }, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      https.get(res.headers.location, { rejectUnauthorized: false }, (res2) => {
          clientRes.writeHead(res2.statusCode, res2.headers);
          res2.pipe(clientRes);
      });
      return;
    }
    clientRes.writeHead(res.statusCode, res.headers);
    res.pipe(clientRes);
  }).on('error', (e) => {
    clientRes.writeHead(500);
    clientRes.end();
  });
});

server.listen(8080, () => console.log('Proxy running on 8080'));
