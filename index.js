const fs = require('fs');
const yaml = require('js-yaml');

Object.assign(process.env, yaml.safeLoad(fs.readFileSync('secrets.prod.yml', 'utf8')));

const handler = require('./handler');

handler.init().then(handler.transferTasks);
// handler.transferTasks()
