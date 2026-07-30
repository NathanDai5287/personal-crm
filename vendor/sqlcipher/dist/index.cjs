"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var index_exports = {};
__export(index_exports, {
  Database: () => Database,
  default: () => Database,
  setLogger: () => setLogger
});
module.exports = __toCommonJS(index_exports);
var import_node_assert = __toESM(require("node:assert"), 1);
var import_node_vm = require("node:vm");
var import_node_url = require("node:url");
var import_node_path = require("node:path");
var import_node_gyp_build = __toESM(require("node-gyp-build"), 1);
const ROOT_DIR = void 0 ? fileURLToPath(new URL("..", void 0)) : (0, import_node_path.join)(__dirname, "..");
const addon = (0, import_node_gyp_build.default)(ROOT_DIR);
class Statement {
  #needsTranslation;
  #cache;
  #createRow;
  #translateParams;
  #native;
  #onClose;
  /** @internal */
  constructor(db, query, { persistent, pluck, bigint }, onClose) {
    this.#needsTranslation = persistent === true && !pluck;
    const paramNames = new Array();
    this.#native = addon.statementNew(
      db,
      query,
      persistent === true,
      pluck === true,
      bigint === true,
      paramNames
    );
    const isArrayParams = paramNames.every((name) => name === null);
    const isObjectParams = !isArrayParams && paramNames.every((name) => typeof name === "string");
    if (!isArrayParams && !isObjectParams) {
      throw new TypeError("Cannot mix named and anonymous params in query");
    }
    if (isArrayParams) {
      this.#translateParams = (params) => {
        if (!Array.isArray(params)) {
          throw new TypeError("Query requires an array of anonymous params");
        }
        return params;
      };
    } else {
      this.#translateParams = (0, import_node_vm.runInThisContext)(`
        (function translateParams(params) {
          if (Array.isArray(params)) {
            throw new TypeError('Query requires an object of named params');
          }
          return [
            ${paramNames.map((name) => `params[${JSON.stringify(name)}]`).join(",\n")}
          ];
        })
      `);
    }
    this.#onClose = onClose;
  }
  /**
   * Run the statement's query without returning any rows.
   *
   * @param params - Parameters to be bound to query placeholders before
   *                 executing the statement.
   * @returns An object with `changes` and `lastInsertedRowid` integers.
   */
  run(params) {
    if (this.#native === void 0) {
      throw new Error("Statement closed");
    }
    const result = [0, 0];
    const nativeParams = this.#checkParams(params);
    addon.statementRun(this.#native, nativeParams, result);
    return { changes: result[0], lastInsertRowid: result[1] };
  }
  /**
   * Run the statement's query and return the first row of the result or
   * `undefined` if no rows matched.
   *
   * @param params - Parameters to be bound to query placeholders before
   *                 executing the statement.
   * @returns A row object or a single column if `pluck: true` is set in the
   *          statement options.
   */
  get(params) {
    if (this.#native === void 0) {
      throw new Error("Statement closed");
    }
    const nativeParams = this.#checkParams(params);
    const result = addon.statementStep(
      this.#native,
      nativeParams,
      this.#cache,
      true
    );
    if (result === void 0) {
      return void 0;
    }
    if (!this.#needsTranslation) {
      return result;
    }
    const createRow = this.#updateCache(result);
    return createRow(result);
  }
  /**
   * Run the statement's query and return the all rows of the result or
   * `undefined` if no rows matched.
   *
   * @param params - Parameters to be bound to query placeholders before
   *                 executing the statement.
   * @returns A list of row objects or single columns if `pluck: true` is set in
   *          the statement options.
   */
  all(params) {
    if (this.#native === void 0) {
      throw new Error("Statement closed");
    }
    const result = [];
    const nativeParams = this.#checkParams(params);
    let singleUseParams = nativeParams;
    while (true) {
      const single = addon.statementStep(
        this.#native,
        singleUseParams,
        this.#cache,
        false
      );
      singleUseParams = null;
      if (single === void 0) {
        break;
      }
      if (!this.#needsTranslation) {
        result.push(single);
        continue;
      }
      const createRow = this.#updateCache(single);
      result.push(createRow(single));
    }
    return result;
  }
  /**
   * Report collected performance statics for the statement.
   *
   * @returns A list of objects describing the performance of the query.
   *
   * @see {@link https://www.sqlite.org/profile.html}
   */
  scanStats() {
    if (this.#native === void 0) {
      throw new Error("Statement closed");
    }
    return addon.statementScanStats(this.#native);
  }
  /**
   * Close the statement and release the used memory.
   */
  close() {
    if (this.#native === void 0) {
      throw new Error("Statement already closed");
    }
    addon.statementClose(this.#native);
    this.#native = void 0;
    this.#onClose?.();
  }
  /** @internal */
  #updateCache(result) {
    if (this.#cache === result) {
      (0, import_node_assert.default)(this.#createRow !== void 0);
      return this.#createRow;
    }
    const half = result.length >>> 1;
    const lines = [];
    for (let i = 0; i < half; i += 1) {
      lines.push(`${JSON.stringify(result[i])}: value[${half} + ${i}],`);
    }
    this.#cache = result;
    const createRow = (0, import_node_vm.runInThisContext)(`(function createRow(value) {
      return {
        ${lines.join("\n")}
      };
    })`);
    this.#createRow = createRow;
    return createRow;
  }
  /** @internal */
  #checkParams(params) {
    if (params === void 0) {
      return void 0;
    }
    if (typeof params !== "object") {
      throw new TypeError("Params must be either object or array");
    }
    if (params === null) {
      throw new TypeError("Params cannot be null");
    }
    return this.#translateParams(params);
  }
}
class Database {
  #native;
  #transactionDepth = 0;
  #isCacheEnabled;
  #statementCache = /* @__PURE__ */ new Map();
  #transactionStmts;
  /**
   * Constructor
   *
   * @param path - The path to the database file or ':memory:'/'' for opening
   *               the in-memory database.
   */
  constructor(path = ":memory:", { cacheStatements } = {}) {
    if (typeof path !== "string") {
      throw new TypeError("Invalid database path");
    }
    this.#native = addon.databaseOpen(path);
    this.#isCacheEnabled = cacheStatements === true;
  }
  initTokenizer() {
    if (this.#native === void 0) {
      throw new Error("Database closed");
    }
    addon.databaseInitTokenizer(this.#native);
  }
  /**
   * Execute one or multiple SQL statements in a given `sql` string.
   *
   * @param sql - one or multiple SQL statements
   */
  exec(sql) {
    if (this.#native === void 0) {
      throw new Error("Database closed");
    }
    if (typeof sql !== "string") {
      throw new TypeError("Invalid sql argument");
    }
    addon.databaseExec(this.#native, sql);
  }
  /**
   * Create custom SQL function with a given `name`.
   *
   * @param name - name of the function
   * @param fn - function implementation
   * @param options - function options.
   */
  createFunction(name, fn, options = {}) {
    if (this.#native === void 0) {
      throw new Error("Database closed");
    }
    if (typeof name !== "string") {
      throw new TypeError("Invalid name argument");
    }
    if (typeof fn !== "function") {
      throw new TypeError("Invalid fn argument");
    }
    addon.databaseCreateFunction(
      this.#native,
      name,
      fn,
      options.bigint === true
    );
  }
  /**
   * Register a callback to be invoked each time data is commited to a database
   * in WAL mode.
   *
   * @param fn - function implementation
   */
  setWalHook(fn) {
    if (this.#native === void 0) {
      throw new Error("Database closed");
    }
    if (typeof fn !== "function") {
      throw new TypeError("Invalid fn argument");
    }
    addon.databaseSetWalHook(this.#native, fn);
  }
  prepare(query, options = {}) {
    if (this.#native === void 0) {
      throw new Error("Database closed");
    }
    if (typeof query !== "string") {
      throw new TypeError("Invalid query argument");
    }
    if (!this.#isCacheEnabled || options.persistent === false) {
      return new Statement(this.#native, query, options);
    }
    const cacheKey = `${options.pluck}:${options.bigint}:${query}`;
    const cached = this.#statementCache.get(cacheKey);
    if (cached !== void 0) {
      return cached;
    }
    const stmt = new Statement(
      this.#native,
      query,
      {
        persistent: true,
        pluck: options.pluck,
        bigint: options.bigint
      },
      () => this.#statementCache.delete(cacheKey)
    );
    this.#statementCache.set(cacheKey, stmt);
    return stmt;
  }
  /**
   * Close the database and all associated statements.
   */
  close() {
    if (this.#native === void 0) {
      throw new Error("Database already closed");
    }
    addon.databaseClose(this.#native);
    this.#native = void 0;
  }
  pragma(source, { simple } = {}) {
    if (typeof source !== "string") {
      throw new TypeError("Invalid pragma argument");
    }
    if (simple === true) {
      const stmt2 = this.prepare(`PRAGMA ${source}`, { pluck: true });
      return stmt2.get();
    }
    const stmt = this.prepare(`PRAGMA ${source}`);
    return stmt.all();
  }
  /**
   * Wrap `fn()` in a transaction.
   *
   * @param fn - a function to be executed within a transaction.
   * @returns The value returned by `fn()`.
   */
  transaction(fn) {
    return (...params) => {
      if (this.#transactionStmts === void 0) {
        const options = { persistent: true, pluck: true };
        this.#transactionStmts = {
          begin: this.prepare("BEGIN", options),
          rollback: this.prepare("ROLLBACK", options),
          commit: this.prepare("COMMIT", options),
          savepoint: this.prepare("SAVEPOINT signalappsqlcipher", options),
          rollbackTo: this.prepare("ROLLBACK TO signalappsqlcipher", options),
          release: this.prepare("RELEASE signalappsqlcipher", options)
        };
      }
      this.#transactionDepth += 1;
      let begin;
      let rollback;
      let commit;
      if (this.#transactionDepth === 1) {
        ({ begin, rollback, commit } = this.#transactionStmts);
      } else {
        ({
          savepoint: begin,
          rollbackTo: rollback,
          release: commit
        } = this.#transactionStmts);
      }
      begin.run();
      try {
        const result = fn(...params);
        commit.run();
        return result;
      } catch (error) {
        try {
          rollback.run();
        } catch (rollbackError) {
          if (rollbackError instanceof Error) {
            rollbackError.cause = error;
          }
          throw rollbackError;
        }
        throw error;
      } finally {
        this.#transactionDepth -= 1;
      }
    };
  }
  /**
   * Tokenize a given sentence with a Signal-FTS5-Extension.
   *
   * @param value - a sentence
   * @returns a list of word-like tokens.
   *
   * @see {@link https://github.com/signalapp/Signal-FTS5-Extension}
   */
  signalTokenize(value) {
    if (typeof value !== "string") {
      throw new TypeError("Invalid value");
    }
    return addon.signalTokenize(value);
  }
}
function setLogger(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("Invalid value");
  }
  return addon.setLogger(fn);
}
