'use strict';
/* Turns src/daybook.html (the single source of the page) into dist/: a complete HTML document with local fonts. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
let src = fs.readFileSync(path.join(root, 'src', 'daybook.html'), 'utf8');

src = src
  .replace(/<link rel="preconnect"[^>]*>\s*/g, '')
  .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '<link rel="stylesheet" href="fonts/fonts.css">');

const cut = src.indexOf('</style>') + '</style>'.length;
const head = src.slice(0, cut), body = src.slice(cut);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
${head}
</head>
<body>
${body}
</body>
</html>
`;

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), page);
fs.cpSync(path.join(root, 'fonts'), path.join(dist, 'fonts'), { recursive: true });
console.log('built dist/index.html (' + Math.round(page.length / 1024) + ' KB)');
