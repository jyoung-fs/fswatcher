const fs = require('fs');
const path = require('path');

const program = require('commander');
const chokidar = require('chokidar');
const AWS = require('aws-sdk');
AWS.config.region = 'us-west-2';
const DEFAULT_CONFIG_FILE = '/etc/fswatcher';

// Sentry support
const raven = require('raven');
raven.on('logged', function () {
  process.stderr.write(`Logged error to sentry`);
});
raven.config('https://dc50f728527148fbbc24e75bfb400bfe:204d3ae41d1849a5ba6fafcac79b00e9@logger.fastspring.com/11').install();

raven.context(function() {
  // Set context
  raven.setContext({
    tags: {
      server: process.env.SERVER_NAME || 'local',
      build: process.env.SERVER_BUILD || 'local'
    }
  });

  // CLI Args
  program
    .version('1.0.0')
    .option('-c, --config [file]', `Configuration file (defaults to ${DEFAULT_CONFIG_FILE})`)
    // .usage('[options]')
    .parse(process.argv);

  // Configuration
  const CONFIG_FILE = program.config || DEFAULT_CONFIG_FILE;

  // Sanity checks
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`${CONFIG_FILE} not found!`);
  }

  let config;
  try {
    config = require(CONFIG_FILE);
  } catch (e) {
    process.stderr.write(`Failed reading configuration file: ${e.name}, ${e.message}\n`);
    process.exit(1);
  }

  if (!config.watches || !Array.isArray(config.watches)) {
    throw new Error(`Configuration file has invalid 'watches' property! It must be an array of directories.`);
  }

  const directories = config.watches.filter((dir) => {
    if (!fs.existsSync(dir)) {
      process.stderr.write(`${dir} does not exist! Ignoring...\n`);
      return true;
    }
    return true;
  });

  // Watchers
  const chokidarConfig = {
    ignored: /(^|[\/\\])\../, //ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    followSymlinks: true,
    useFsEvents: true,
    usePolling: false,
    alwaysStat: false,
    depth: 1,
    awaitWriteFinish: false,
    ignorePermissionErrors: true,
    atomic: true // or a custom 'atomicity delay', in milliseconds (default 100)
  };

  const watcher = chokidar.watch(directories, chokidarConfig);

  watcher
    .on('add', path => sendAlert(path, 'added'))
    .on('change', path => sendAlert(path, 'changed'))
    .on('unlink', path => sendAlert(path, 'removed'))
    .on('addDir', path => sendAlert(path, 'directory added'))
    .on('unlinkDir', path => sendAlert(path, 'directory removed'))
    .on('error', error => sendError(`Watcher error: ${error}`))
    .on('ready', function () {
      process.stdout.write('Initial scan complete, watching for file changes...\n');
    });

  const cloudwatch = new AWS.CloudWatchEvents({apiVersion: '2015-10-07'});
  const sendAlert = raven.wrap((path, event) => {
    process.stdout.write(`${path} was ${event}\n`);
    const detail = {
      path: path,
      event: event
    };
    const params = {
      Entries: [{
        Detail: JSON.stringify(detail),
        DetailType: `Path ${path}, Event ${event}`,
        Resources: [],
        Source: 'fswatcher'
      }]
    };
    cloudwatch.putEvents(params, (err, data) => {
      if (err) sendError('Failed sending to CloudWatch', {error: err, stack: err.stack});
      else {process.stdout.write(`Successfully sent ${JSON.stringify(detail)} to CloudWatch\n`);
      process.stdout.write(`Sent ${JSON.stringify(params)}\n`);}
    });
  });

  function sendError(msg, extras) {
    const config = {
      level: 'error'
    };
    if (extras) {
      config.extras = extras;
    }
    raven.captureException(new Error(msg), config);
    process.stderr.write(`Error: ${msg}, extras: ${extras}\n`);
  }

  process.on('SIGTERM', raven.wrap(() => {
    if (watcher) watcher.close();
    process.exit(0);
  }));
});