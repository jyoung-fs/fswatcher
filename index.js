const fs = require('fs');
const path = require('path');

const program = require('commander');
const chokidar = require('chokidar');
const AWS = require('aws-sdk');
const region = process.env.PROD ? 'us-east-1' : 'us-west-2';
AWS.config.update({region});

const DEFAULT_CONFIG_FILE = '/etc/fswatcher';
const SENTRY_DSN = 'https://dc50f728527148fbbc24e75bfb400bfe:204d3ae41d1849a5ba6fafcac79b00e9@logger.fastspring.com/11';

// Sentry support
const raven = require('raven');
raven.config(SENTRY_DSN, {tags: {
  server: process.env.SERVER_NAME || 'local',
  build: process.env.SERVER_BUILD || 'local'
}}).install((success, err) => {
  process.stderr.write(`Unexpected error: ${err.toString()}`);
  if (!success) {
    process.stderr.write(`Failed sending to Sentry!\n`);
  }
});

raven.context({}, run, onError);

function run() {
  // CLI Args
  program
    .version('1.0.0')
    .option('-c, --config [file]', `Configuration file (defaults to ${DEFAULT_CONFIG_FILE})`)
    .option('-v, --verbose', `Turn on verbose mode`)
    // .usage('[options]')
    .parse(process.argv);

  // Configuration
  const CONFIG_FILE = program.config || DEFAULT_CONFIG_FILE;

  if (program.verbose) {
    process.stdout.write(`Using config file: ${CONFIG_FILE}\n`);
  }

  // Sanity checks
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`${CONFIG_FILE} not found!`);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE));
  } catch (e) {
    process.stderr.write(`Failed reading configuration file\n${e.name}: ${e.message}\n`);
    process.exit(1);
  }

  if (!config.watches || !Array.isArray(config.watches)) {
    throw new Error(`Configuration file has invalid 'watches' property! It must be an array of directories.`);
  }

  const directories = config.watches.filter((dir) => {
    if (!fs.existsSync(dir)) {
      if (program.verbose) {
        process.stderr.write(`Ignoring non-existent directory: ${dir}\n`);
      }
      return false;
    }
    return true;
  });

  if (directories.length === 0) {
    throw new Error('No watchable items found');
  }

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

  const watcher = chokidar
    .watch(directories, chokidarConfig)
    .on('add', path => sendAlert(path, 'added'))
    .on('change', path => sendAlert(path, 'changed'))
    .on('unlink', path => sendAlert(path, 'removed'))
    .on('addDir', path => sendAlert(path, 'directory added'))
    .on('unlinkDir', path => sendAlert(path, 'directory removed'))
    .on('error', error => sendError(`Watcher error: ${error}`))
    .on('ready', function () {
      if (program.verbose) {
        process.stdout.write('Initial scan complete, watching for file changes...\n');
      }
    });

  const cloudwatch = new AWS.CloudWatchEvents({apiVersion: '2015-10-07'});
  const sendAlert = raven.wrap((path, event) => {
    if (program.verbose) {
      process.stdout.write(`Sending alert for event: ${event}, with path: ${path}\n`);
    }
    const detail = {path, event};
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
      else if (program.verbose) {
        process.stdout.write(`Successfully sent ${JSON.stringify(detail)} to CloudWatch\n`);
      }
    });
  });

  function shutdown() {
    if (program.verbose) {
      process.stdout.write('Caught signal, shutting down...');
    }
    if (watcher) {
      watcher.close();
    }
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function sendError(msg, extras) {
  const config = {
    level: 'error'
  };
  if (extras) {
    config.extra = extras;
  }
  raven.captureException(msg, config);
}

function onError(err) {
  process.stderr.write(err.toString() + '\n');
  raven.captureException(err);
}