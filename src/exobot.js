import Emitter from 'eventemitter3';
import Log from 'log';
import superagent from 'superagent';
import sapp from 'superagent-promise-plugin';
import { intersection } from 'lodash/array';
import { merge } from 'lodash';

sapp.Promise = Promise;

import { Permissions } from './plugins/plugins';
import { TextMessage } from './messages';

import { Configurable, PropTypes as T } from './configurable';

import { Adapter } from './adapters';
import { Plugin } from './plugins';

// export here for backwards compatibility
export const PropTypes = T;

const http = sapp.patch(superagent);
const USERS_DB = 'exobot-users';

const CLASS_NAME_FOR_CONFIG = 'exobot';

import { DB } from './db';

export class Exobot extends Configurable {
  plugins = [];
  adapters = {};

  name = CLASS_NAME_FOR_CONFIG;

  propTypes = {
    name: T.string.isRequired,
    key: T.string.isRequired,
    adapters: T.arrayOf(T.instanceOf(Adapter)).isRequired,
    plugins: T.arrayOf(T.instanceOf(Plugin)).isRequired,
    port: T.number.isRequired,
    requirePermissions: T.bool.isRequired,
    logLevel: T.number,
    alias: T.string,
  };

  defaultProps = {
    name: 'exobot',
    adapters: [],
    plugins: [],
    port: 8080,
    logLevel: Log.WARNING,
    requirePermissions: false,
  }

  constructor (options={}) {
    super();

    this.log = this.initLog(options.logLevel);
    process.on('unhandledRejection', this.log.critical.bind(this.log));

    this.configure(options, this.log);
  }

  configure (options, log) {
    super.configure(options, log);

    this.botNameRegex =
      new RegExp(`^(?:(?:@?${this.options.name}|${this.options.alias})[,\\s:.-]*)(.+)`, 'i');

    this.emitter = new Emitter();
    this.http = http;
    this.requirePermissions = this.options.requirePermissions;

    this.initialize();
  }

  async initialize() {
    const dbPath = this.options.dbPath || `./data/${this.options.name}.json`;

    try {
      await this.initDB(this.options.key, dbPath, this.options.readFile, this.options.writeFile);
    } catch (e) {
      this.log.critical(e);
      return;
    }

    try {
      this.initUsers();
      this.initAdapters(this.options.adapters);
      this.initPlugins(this.options.plugins);
    } catch (e) {
      this.log.critical(e);
    }
  }

  initAdapters (adapters=[]) {
    adapters.forEach(this.addAdapter);
  }

  initPlugins (plugins=[]) {
    this.usePermissions = !!plugins.find(p => p instanceof Permissions);
    plugins.forEach(this.addPlugin);
  }

  initLog (logLevel) {
    return new Log(logLevel);
  }

  async initDB (key, dbPath, readFile, writeFile) {
    if (!key) {
      const err = new Error('Pass options.key in to bot initializer. Database not initializing.');
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      DB({
        key,
        readFile,
        writeFile,
        path: dbPath,
        emitter: this.emitter,
      }).then((db) => {
        this.db = db;
        this.emitter.emit('dbLoaded', db);
        resolve(db);
      }, (err) => {
        this.log.critical.bind(this.log);
        reject(err);
      });
    });
  }

  initUsers () {
    this.users = this.db.get(USERS_DB).value();

    if (this.users) {
      this.log.debug(Object.keys(this.users.botUsers).length, 'exobot users');
      return;
    }

    this.db.set(USERS_DB, {botUsers: {}}).value();
    this.users = this.db.get(USERS_DB).value();
  }

  mergeUsers = (destUser, srcUser) => {
    if (destUser && srcUser) {
      merge(destUser.roles, srcUser.roles);

      Object.keys(srcUser.adapters).map(adapter => {
        this.users[adapter][srcUser.adapters[adapter].userId].botId = destUser.id;
      });

      merge(destUser.adapters, srcUser.adapters);

      delete this.users.botUsers[srcUser.id];

      this.db.write();
      return 'Login complete';
    }
  }

  addRole = (userId, roleName) => {
    this.users.botUsers[userId].roles[roleName] = true;
    this.db.write();
  }

  getRoles = (userId) => {
    return Object.keys(this.users.botUsers[userId].roles);
  }

  removeRole = (userId, roleName) => {
    const roles = this.users.botUsers[userId].roles;
    delete roles[roleName];
    this.db.write();
  }

  getUserRoles = (userId) => {
    const user = this.users.botUsers[userId];
    let roles = [];

    if (user) {
      Object.keys(user.adapters).map(adapter => {
        const adapterRoles = this.adapters[adapter].getRolesForUser(user.adapters[adapter].userId);
        if (adapterRoles) {
          roles = roles.concat(adapterRoles);
        }
      });

      roles = roles.concat(Object.keys(user.roles));
      return roles;
    }
  }

  async checkPermissions (userId, commandPermissionGroup) {
    if (!this.usePermissions) { return true; }
    // special group for admin authorization - otherwise you could never auth
    // in the first place when public commands are disabled
    if (commandPermissionGroup === 'permissions.public') { return true; }

    // get user's roles
    const roles = this.getUserRoles(userId);
    // if user has `admin` role, allow it
    if (roles && roles.includes('admin')) { return true; }

    // get roles assigned to the command group
    const groups = this.db.get(`permissions.groups.${commandPermissionGroup}`).value();
    // if there are no groups, and requirePermissions is false, allow it
    // requirePermissions = false == (public by default)
    if (!groups || !Object.keys(groups)) {
      if (!this.requirePermissions) {
        return true;
      }

      // otherwise, if there are no groups, and we're not an admin, return
      // false.
      return false;
    }
    // if command is in `public`, allow it
    if (groups.public) { return true; }

    // check user's list of roles against list of groups that have the command
    // if there's a match (user is in a group with the command), allow it
    if (intersection(roles, Object.keys(groups)).length) {
      return true;
    }

    return false;
  }

  addPlugin = plugin => {
    const name = plugin.name;

    if (this.getPluginByName(name)) {
      this.log.warning(`Multiple plugins with name "${name}" were initialized.`);
    }

    plugin.register(this);
    this.plugins.push(plugin);
  }

  addAdapter = adapter => {
    const name = adapter.name;

    if (this.getAdapterByName(name)) {
      this.log.warning(`Multiple "${name}" adapters were initialized.`);
    }

    adapter.register(this);
    this.adapters[adapter.name] = adapter;
  }

  send = message => {
    if (!message.text) { return; }
    const adapter = this.getAdapterByMessage(message);

    if (!adapter) {
      this.log.warning(`Message sent with invalid adapter: ${message.adapter}`);
      return;
    }

    adapter.send(message);
  }

  getByName = (name, list) => {
    return Object
            .keys(list)
            .map(id => list[id])
            .find(p => p.name.toLowerCase() === name.toLowerCase());
  }

  getPluginByName = name => {
    return this.getByName(name, this.plugins);
  }

  getAdapterByMessage = message => {
    return this.adapters[message.adapter];
  }


  getAdapterByName = name => {
    return this.getByName(name, this.adapters);
  }

  parseMessage = message => {
    const { text } = message;

    if (message.whisper) {
      return new TextMessage({ ...message, respond: true });
    }

    const exec = this.botNameRegex.exec(text);

    if (exec) {
      return new TextMessage({ ...message, text: exec[1], respond: true });
    }

    return new TextMessage(message);
  }
}

export * from './adapters';
export * from './messages';
export * from './plugins';
export * from './db';
export { default as User } from './user';
export const LogLevels = Log;
