const http = require('node:http');
http.createServer((req,res)=>{
  let body=''; req.on('data',chunk=>body+=chunk);
  req.on('end',()=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const word=url.searchParams.get('word') || (body ? JSON.parse(body).word : 'example');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({translation:'释义：'+word,phonetic:'/test/',examples:['This is '+word+'.']}));
  });
}).listen(18271,'127.0.0.1',()=>console.log('Mock dictionary on 18271'));
