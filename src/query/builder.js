
// Builder
// -------
var assert       = require('assert')
var inherits     = require('inherits')
var EventEmitter = require('events').EventEmitter

var Raw         = require('../raw')
var helpers     = require('../helpers')
var JoinClause  = require('./joinclause')
import {clone, isUndefined, isNumber, assign, toArray, isObject, isFunction, isEmpty, isBoolean, isString, each, tail} from 'lodash'

// Typically called from `knex.builder`,
// start a new query building chain.
function Builder(client) {
  this.client      = client
  this.and         = this;
  this._single     = {};
  this._statements = [];
  this._method    = 'select'
  this._debug     = client.config && client.config.debug;

  // Internal flags used in the builder.
  this._joinFlag  = 'inner';
  this._boolFlag  = 'and';
  this._notFlag   = false;
}
inherits(Builder, EventEmitter);

assign(Builder.prototype, {

  toString: function() {
    return this.toQuery();
  },

  // Convert the current query "toSQL"
  toSQL: function(method) {
    return this.client.queryCompiler(this).toSQL(method || this._method);
  },

  // Create a shallow clone of the current query builder.
  clone() {
    const cloned        = new this.constructor(this.client);
    cloned._method      = this._method;
    cloned._single      = clone(this._single);
    cloned._statements  = clone(this._statements);
    cloned._debug       = this._debug;

    // `_option` is assigned by the `Interface` mixin.
    if (!isUndefined(this._options)) {
      cloned._options = clone(this._options);
    }

    return cloned;
  },

  timeout: function(ms) {
    if(isNumber(ms) && ms > 0) {
      this._timeout = ms;
    }
    return this;
  },

  // Select
  // ------

  // Adds a column or columns to the list of "columns"
  // being selected on the query.
  columns: function(column) {
    if (!column) return this;
    this._statements.push({
      grouping: 'columns',
      value: helpers.normalizeArr.apply(null, arguments)
    });
    return this;
  },

  // Allow for a sub-select to be explicitly aliased as a column,
  // without needing to compile the query in a where.
  as: function(column) {
    this._single.as = column;
    return this;
  },

  // Prepends the `schemaName` on `tableName` defined by `.table` and `.join`.
  withSchema: function(schemaName) {
    this._single.schema = schemaName;
    return this;
  },

  // Sets the `tableName` on the query.
  // Alias to "from" for select and "into" for insert statements
  // e.g. builder.insert({a: value}).into('tableName')
  table: function(tableName) {
    this._single.table = tableName;
    return this;
  },

  // Adds a `distinct` clause to the query.
  distinct: function() {
    this._statements.push({
      grouping: 'columns',
      value: helpers.normalizeArr.apply(null, arguments),
      distinct: true
    });
    return this;
  },

  // Adds a join clause to the query, allowing for advanced joins
  // with an anonymous function as the second argument.
  // function(table, first, operator, second)
  join: function(table, first) {
    var join;
    var schema = this._single.schema;
    var joinType = this._joinType();
    if (typeof first === 'function') {
      join = new JoinClause(table, joinType, schema);
      first.call(join, join);
    } else if (joinType === 'raw') {
      join = new JoinClause(this.client.raw(table, first), 'raw');
    } else {
      join = new JoinClause(table, joinType, schema);
      if (arguments.length > 1) {
        join.on.apply(join, toArray(arguments).slice(1));
      }
    }
    this._statements.push(join);
    return this;
  },

  // JOIN blocks:
  innerJoin: function() {
    return this._joinType('inner').join.apply(this, arguments);
  },
  leftJoin: function() {
    return this._joinType('left').join.apply(this, arguments);
  },
  leftOuterJoin: function() {
    return this._joinType('left outer').join.apply(this, arguments);
  },
  rightJoin: function() {
    return this._joinType('right').join.apply(this, arguments);
  },
  rightOuterJoin: function() {
    return this._joinType('right outer').join.apply(this, arguments);
  },
  outerJoin: function() {
    return this._joinType('outer').join.apply(this, arguments);
  },
  fullOuterJoin: function() {
    return this._joinType('full outer').join.apply(this, arguments);
  },
  crossJoin: function() {
    return this._joinType('cross').join.apply(this, arguments);
  },
  joinRaw: function() {
    return this._joinType('raw').join.apply(this, arguments);
  },

  // The where function can be used in several ways:
  // The most basic is `where(key, value)`, which expands to
  // where key = value.
  where: function(column, operator, value) {

    // Support "where true || where false"
    if (column === false || column === true) {
      return this.where(1, '=', column ? 1 : 0)
    }

    // Check if the column is a function, in which case it's
    // a where statement wrapped in parens.
    if (typeof column === 'function') {
      return this.whereWrapped(column);
    }

    // Allow a raw statement to be passed along to the query.
    if (column instanceof Raw && arguments.length === 1) return this.whereRaw(column);

    // Allows `where({id: 2})` syntax.
    if (isObject(column) && !(column instanceof Raw)) return this._objectWhere(column);

    // Enable the where('key', value) syntax, only when there
    // are explicitly two arguments passed, so it's not possible to
    // do where('key', '!=') and have that turn into where key != null
    if (arguments.length === 2) {
      value    = operator;
      operator = '=';

      // If the value is null, and it's a two argument query,
      // we assume we're going for a `whereNull`.
      if (value === null) {
        return this.whereNull(column);
      }
    }

    // lower case the operator for comparison purposes
    var checkOperator = ('' + operator).toLowerCase().trim();

    // If there are 3 arguments, check whether 'in' is one of them.
    if (arguments.length === 3) {
      if (checkOperator === 'in' || checkOperator === 'not in') {
        return this._not(checkOperator === 'not in').whereIn(arguments[0], arguments[2]);
      }
      if (checkOperator === 'between' || checkOperator === 'not between') {
        return this._not(checkOperator === 'not between').whereBetween(arguments[0], arguments[2]);
      }
    }

    // If the value is still null, check whether they're meaning
    // where value is null
    if (value === null) {

      // Check for .where(key, 'is', null) or .where(key, 'is not', 'null');
      if (checkOperator === 'is' || checkOperator === 'is not') {
        return this._not(checkOperator === 'is not').whereNull(column);
      }
    }

    // Push onto the where statement stack.
    this._statements.push({
      grouping: 'where',
      type: 'whereBasic',
      column: column,
      operator: operator,
      value: value,
      not: this._not(),
      bool: this._bool()
    });
    return this;
  },
  // Adds an `or where` clause to the query.
  orWhere: function orWhere() {
    this._bool('or');
    var obj = arguments[0];
    if(isObject(obj) && !isFunction(obj) && !(obj instanceof Raw)) {
      return this.whereWrapped(function() {
        for(let key in obj) {
          this.andWhere(key, obj[key]);
        }
      });
    }
    return this.where.apply(this, arguments);
  },

  // Adds an `not where` clause to the query.
  whereNot: function() {
    return this._not(true).where.apply(this, arguments);
  },

  // Adds an `or not where` clause to the query.
  orWhereNot: function() {
    return this._bool('or').whereNot.apply(this, arguments);
  },

  // Processes an object literal provided in a "where" clause.
  _objectWhere: function(obj) {
    var boolVal = this._bool();
    var notVal = this._not() ? 'Not' : '';
    for (var key in obj) {
      this[boolVal + 'Where' + notVal](key, obj[key]);
    }
    return this;
  },

  // Adds a raw `where` clause to the query.
  whereRaw: function(sql, bindings) {
    var raw = (sql instanceof Raw ? sql : this.client.raw(sql, bindings));
    this._statements.push({
      grouping: 'where',
      type: 'whereRaw',
      value: raw,
      bool: this._bool()
    });
    return this;
  },

  orWhereRaw: function(sql, bindings) {
    return this._bool('or').whereRaw(sql, bindings);
  },

  // Helper for compiling any advanced `where` queries.
  whereWrapped: function(callback) {
    this._statements.push({
      grouping: 'where',
      type: 'whereWrapped',
      value: callback,
      not: this._not(),
      bool: this._bool()
    });
    return this;
  },


  // Helper for compiling any advanced `having` queries.
  havingWrapped: function(callback) {
    this._statements.push({
      grouping: 'having',
      type: 'whereWrapped',
      value: callback,
      bool: this._bool()
    });
    return this;
  },

  // Adds a `where exists` clause to the query.
  whereExists: function(callback) {
    this._statements.push({
      grouping: 'where',
      type: 'whereExists',
      value: callback,
      not: this._not(),
      bool: this._bool(),
    });
    return this;
  },

  // Adds an `or where exists` clause to the query.
  orWhereExists: function(callback) {
    return this._bool('or').whereExists(callback);
  },

  // Adds a `where not exists` clause to the query.
  whereNotExists: function(callback) {
    return this._not(true).whereExists(callback);
  },

  // Adds a `or where not exists` clause to the query.
  orWhereNotExists: function(callback) {
    return this._bool('or').whereNotExists(callback);
  },

  // Adds a `where in` clause to the query.
  whereIn: function(column, values) {
    if (Array.isArray(values) && isEmpty(values)) return this.where(this._not());
    this._statements.push({
      grouping: 'where',
      type: 'whereIn',
      column: column,
      value: values,
      not: this._not(),
      bool: this._bool()
    });
    return this;
  },

  // Adds a `or where in` clause to the query.
  orWhereIn: function(column, values) {
    return this._bool('or').whereIn(column, values);
  },

  // Adds a `where not in` clause to the query.
  whereNotIn: function(column, values) {
    return this._not(true).whereIn(column, values);
  },

  // Adds a `or where not in` clause to the query.
  orWhereNotIn: function(column, values) {
    return this._bool('or')._not(true).whereIn(column, values);
  },

  // Adds a `where null` clause to the query.
  whereNull: function(column) {
    this._statements.push({
      grouping: 'where',
      type: 'whereNull',
      column: column,
      not: this._not(),
      bool: this._bool()
    });
    return this;
  },

  // Adds a `or where null` clause to the query.
  orWhereNull: function(column) {
    return this._bool('or').whereNull(column);
  },

  // Adds a `where not null` clause to the query.
  whereNotNull: function(column) {
    return this._not(true).whereNull(column);
  },

  // Adds a `or where not null` clause to the query.
  orWhereNotNull: function(column) {
    return this._bool('or').whereNotNull(column);
  },

  // Adds a `where between` clause to the query.
  whereBetween: function(column, values) {
    assert(Array.isArray(values), 'The second argument to whereBetween must be an array.')
    assert(values.length === 2, 'You must specify 2 values for the whereBetween clause')
    this._statements.push({
      grouping: 'where',
      type: 'whereBetween',
      column: column,
      value: values,
      not: this._not(),
      bool: this._bool()
    });
    return this;
  },

  // Adds a `where not between` clause to the query.
  whereNotBetween: function(column, values) {
    return this._not(true).whereBetween(column, values);
  },

  // Adds a `or where between` clause to the query.
  orWhereBetween: function(column, values) {
    return this._bool('or').whereBetween(column, values);
  },

  // Adds a `or where not between` clause to the query.
  orWhereNotBetween: function(column, values) {
    return this._bool('or').whereNotBetween(column, values);
  },

  // Adds a `group by` clause to the query.
  groupBy: function(item) {
    if (item instanceof Raw) {
      return this.groupByRaw.apply(this, arguments);
    }
    this._statements.push({
      grouping: 'group',
      type: 'groupByBasic',
      value: helpers.normalizeArr.apply(null, arguments)
    });
    return this;
  },

  // Adds a raw `group by` clause to the query.
  groupByRaw: function(sql, bindings) {
    var raw = (sql instanceof Raw ? sql : this.client.raw(sql, bindings));
    this._statements.push({
      grouping: 'group',
      type: 'groupByRaw',
      value: raw
    });
    return this;
  },

  // Adds a `order by` clause to the query.
  orderBy: function(column, direction) {
    this._statements.push({
      grouping: 'order',
      type: 'orderByBasic',
      value: column,
      direction: direction
    });
    return this;
  },

  // Add a raw `order by` clause to the query.
  orderByRaw: function(sql, bindings) {
    var raw = (sql instanceof Raw ? sql : this.client.raw(sql, bindings));
    this._statements.push({
      grouping: 'order',
      type: 'orderByRaw',
      value: raw
    });
    return this;
  },

  // Add a union statement to the query.
  union: function(callbacks, wrap) {
    if (arguments.length === 1 ||
        (arguments.length === 2 && isBoolean(wrap))) {
      if (!Array.isArray(callbacks)) {
        callbacks = [callbacks];
      }
      for (var i = 0, l = callbacks.length; i < l; i++) {
        this._statements.push({
          grouping: 'union',
          clause: 'union',
          value: callbacks[i],
          wrap: wrap || false
        });
      }
    } else {
      callbacks = toArray(arguments).slice(0, arguments.length - 1);
      wrap = arguments[arguments.length - 1];
      if (!isBoolean(wrap)) {
        callbacks.push(wrap);
        wrap = false;
      }
      this.union(callbacks, wrap);
    }
    return this;
  },

  // Adds a union all statement to the query.
  unionAll: function(callback, wrap) {
    this._statements.push({
      grouping: 'union',
      clause: 'union all',
      value: callback,
      wrap: wrap || false
    });
    return this;
  },

  // Adds a `having` clause to the query.
  having: function(column, operator, value) {
    if (column instanceof Raw && arguments.length === 1) {
      return this._havingRaw(column);
    }

    // Check if the column is a function, in which case it's
    // a having statement wrapped in parens.
    if (typeof column === 'function') {
      return this.havingWrapped(column);
    }

    this._statements.push({
      grouping: 'having',
      type: 'havingBasic',
      column: column,
      operator: operator,
      value: value,
      bool: this._bool()
    });
    return this;
  },
  // Adds an `or having` clause to the query.
  orHaving: function() {
    return this._bool('or').having.apply(this, arguments);
  },
  havingRaw: function(sql, bindings) {
    return this._havingRaw(sql, bindings);
  },
  orHavingRaw: function(sql, bindings) {
    return this._bool('or').havingRaw(sql, bindings);
  },
  // Adds a raw `having` clause to the query.
  _havingRaw: function(sql, bindings) {
    var raw = (sql instanceof Raw ? sql : this.client.raw(sql, bindings));
    this._statements.push({
      grouping: 'having',
      type: 'havingRaw',
      value: raw,
      bool: this._bool()
    });
    return this;
  },

  // Only allow a single "offset" to be set for the current query.
  offset: function(value) {
    this._single.offset = value;
    return this;
  },

  // Only allow a single "limit" to be set for the current query.
  limit: function(value) {
    var val = parseInt(value, 10)
    if (isNaN(val)) {
      helpers.warn('A valid integer must be provided to limit')
    } else {
      this._single.limit = val;
    }
    return this;
  },

  // Retrieve the "count" result of the query.
  count: function(column) {
    return this._aggregate('count', (column || '*'));
  },

  // Retrieve the minimum value of a given column.
  min: function(column) {
    return this._aggregate('min', column);
  },

  // Retrieve the maximum value of a given column.
  max: function(column) {
    return this._aggregate('max', column);
  },

  // Retrieve the sum of the values of a given column.
  sum: function(column) {
    return this._aggregate('sum', column);
  },

  // Retrieve the average of the values of a given column.
  avg: function(column) {
    return this._aggregate('avg', column);
  },

  // Retrieve the "count" of the distinct results of the query.
  countDistinct: function(column) {
    return this._aggregate('count', (column || '*'), true);
  },

  // Retrieve the sum of the distinct values of a given column.
  sumDistinct: function(column) {
    return this._aggregate('sum', column, true);
  },

  // Retrieve the vg of the distinct results of the query.
  avgDistinct: function(column) {
    return this._aggregate('avg', column, true);
  },

  // Increments a column's value by the specified amount.
  increment: function(column, amount) {
    return this._counter(column, amount);
  },

  // Decrements a column's value by the specified amount.
  decrement: function(column, amount) {
    return this._counter(column, amount, '-');
  },

  // Sets the values for a `select` query, informing that only the first
  // row should be returned (limit 1).
  first: function() {
    var i, args = new Array(arguments.length);
    for (i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }
    this.select.apply(this, args);
    this._method = 'first';
    this.limit(1);
    return this;
  },

  // Pluck a column from a query.
  pluck: function(column) {
    this._method = 'pluck';
    this._single.pluck = column;
    this._statements.push({
      grouping: 'columns',
      type: 'pluck',
      value: column
    });
    return this;
  },

  // Insert & Update
  // ------

  // Sets the values for an `insert` query.
  insert: function(values, returning) {
    this._method = 'insert';
    if (!isEmpty(returning)) this.returning(returning);
    this._single.insert = values
    return this;
  },

  // Sets the values for an `update`, allowing for both
  // `.update(key, value, [returning])` and `.update(obj, [returning])` syntaxes.
  update: function(values, returning) {
    var ret, obj = this._single.update || {};
    this._method = 'update';
    if (isString(values)) {
      obj[values] = returning;
      if (arguments.length > 2) {
        ret = arguments[2];
      }
    } else {
      var i = -1, keys = Object.keys(values)
      if (this._single.update) {
        helpers.warn('Update called multiple times with objects.')
      }
      while (++i < keys.length) {
        obj[keys[i]] = values[keys[i]]
      }
      ret = arguments[1];
    }
    if (!isEmpty(ret)) this.returning(ret);
    this._single.update = obj;
    return this;
  },

  // Sets the returning value for the query.
  returning: function(returning) {
    this._single.returning = returning;
    return this;
  },

  // Delete
  // ------

  // Executes a delete statement on the query;
  delete: function(ret) {
    this._method = 'del';
    if (!isEmpty(ret)) this.returning(ret);
    return this;
  },


  // Truncates a table, ends the query chain.
  truncate: function(tableName) {
    this._method = 'truncate';
    if (tableName) {
      this._single.table = tableName
    }
    return this;
  },

  // Retrieves columns for the table specified by `knex(tableName)`
  columnInfo: function(column) {
    this._method = 'columnInfo';
    this._single.columnInfo = column;
    return this;
  },

  // Set a lock for update constraint.
  forUpdate: function() {
    this._single.lock = 'forUpdate';
    return this;
  },

  // Set a lock for share constraint.
  forShare: function() {
    this._single.lock = 'forShare';
    return this;
  },

  // Takes a JS object of methods to call and calls them
  fromJS: function(obj) {
    each(obj, (val, key) => {
      if (typeof this[key] !== 'function') {
        helpers.warn('Knex Error: unknown key ' + key)
      }
      if (Array.isArray(val)) {
        this[key].apply(this, val)
      } else {
        this[key](val)
      }
    })
    return this
  },

  // Passes query to provided callback function, useful for e.g. composing
  // domain-specific helpers
  modify: function(callback) {
    callback.apply(this, [this].concat(tail(arguments)));
    return this;
  },

  // ----------------------------------------------------------------------

  // Helper for the incrementing/decrementing queries.
  _counter: function(column, amount, symbol) {
    var amt = parseInt(amount, 10);
    if (isNaN(amt)) amt = 1;
    this._method = 'counter';
    this._single.counter = {
      column: column,
      amount: amt,
      symbol: (symbol || '+')
    };
    return this;
  },

  // Helper to get or set the "boolFlag" value.
  _bool: function(val) {
    if (arguments.length === 1) {
      this._boolFlag = val;
      return this;
    }
    var ret = this._boolFlag;
    this._boolFlag = 'and';
    return ret;
  },

  // Helper to get or set the "notFlag" value.
  _not: function(val) {
    if (arguments.length === 1) {
      this._notFlag = val;
      return this;
    }
    var ret = this._notFlag;
    this._notFlag = false;
    return ret;
  },

  // Helper to get or set the "joinFlag" value.
  _joinType: function (val) {
    if (arguments.length === 1) {
      this._joinFlag = val;
      return this;
    }
    var ret = this._joinFlag || 'inner';
    this._joinFlag = 'inner';
    return ret;
  },

  // Helper for compiling any aggregate queries.
  _aggregate: function(method, column, aggregateDistinct) {
    this._statements.push({
      grouping: 'columns',
      type: 'aggregate',
      method: method,
      value: column,
      aggregateDistinct: aggregateDistinct || false
    });
    return this;
  }

})

Object.defineProperty(Builder.prototype, 'or', {
  get: function () {
    return this._bool('or');
  }
});

Object.defineProperty(Builder.prototype, 'not', {
  get: function () {
    return this._not(true);
  }
});

Builder.prototype.select             = Builder.prototype.columns
Builder.prototype.column             = Builder.prototype.columns
Builder.prototype.andWhereNot        = Builder.prototype.whereNot
Builder.prototype.andWhere           = Builder.prototype.where
Builder.prototype.andWhereRaw        = Builder.prototype.whereRaw
Builder.prototype.andWhereBetween    = Builder.prototype.whereBetween
Builder.prototype.andWhereNotBetween = Builder.prototype.whereNotBetween
Builder.prototype.andHaving          = Builder.prototype.having
Builder.prototype.from               = Builder.prototype.table
Builder.prototype.into               = Builder.prototype.table
Builder.prototype.del                = Builder.prototype.delete

// Attach all of the top level promise methods that should be chainable.
require('../interface')(Builder);

module.exports = Builder;
