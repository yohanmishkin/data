require("ember-data/system/model/states");
require("ember-data/system/mixins/load_promise");

/**
  @module ember-data
*/

var LoadPromise = DS.LoadPromise; // system/mixins/load_promise

var get = Ember.get, set = Ember.set, map = Ember.EnumerableUtils.map,
    merge = Ember.merge, once = Ember.run.once;

var arrayMap = Ember.ArrayPolyfills.map;

var retrieveFromCurrentState = Ember.computed(function(key, value) {
  return get(get(this, 'currentState'), key);
}).property('currentState').readOnly();

/**

  The model class that all Ember Data records descend from.

  @class Model
  @namespace DS
  @extends Ember.Object
  @uses Ember.Evented
  @uses DS.LoadPromise
*/
DS.Model = Ember.Object.extend(Ember.Evented, {
  isEmpty: retrieveFromCurrentState,
  isLoading: retrieveFromCurrentState,
  isLoaded: retrieveFromCurrentState,
  isReloading: retrieveFromCurrentState,
  isDirty: retrieveFromCurrentState,
  isSaving: retrieveFromCurrentState,
  isDeleted: retrieveFromCurrentState,
  isError: retrieveFromCurrentState,
  isNew: retrieveFromCurrentState,
  isValid: retrieveFromCurrentState,
  dirtyType: retrieveFromCurrentState,

  clientId: null,
  id: null,
  transaction: null,
  currentState: null,
  errors: null,

  /**
    Create a JSON representation of the record, using the serialization
    strategy of the store's adapter.

    @method serialize
    @param {Object} options Available options:

    * `includeId`: `true` if the record's ID should be included in the
      JSON representation.

    @returns {Object} an object whose values are primitive JSON values only
  */
  serialize: function(options) {
    var store = get(this, 'store');
    return store.serialize(this, options);
  },

  /**
    Use {{#crossLink "DS.JSONSerializer"}}DS.JSONSerializer{{/crossLink}} to
    get the JSON representation of a record.

    @method toJSON
    @param {Object} options Available options:

    * `includeId`: `true` if the record's ID should be included in the
      JSON representation.

    @returns {Object} A JSON representation of the object.
  */
  toJSON: function(options) {
    var serializer = DS.JSONSerializer.create();
    return serializer.serialize(this, options);
  },

  /**
    Fired when the record is loaded from the server.

    @event didLoad
  */
  didLoad: Ember.K,

  /**
    Fired when the record is reloaded from the server.

    @event didReload
  */
  didReload: Ember.K,

  /**
    Fired when the record is updated.

    @event didUpdate
  */
  didUpdate: Ember.K,

  /**
    Fired when the record is created.

    @event didCreate
  */
  didCreate: Ember.K,

  /**
    Fired when the record is deleted.

    @event didDelete
  */
  didDelete: Ember.K,

  /**
    Fired when the record becomes invalid.

    @event becameInvalid
  */
  becameInvalid: Ember.K,

  /**
    Fired when the record enters the error state.

    @event becameError
  */
  becameError: Ember.K,

  data: Ember.computed(function() {
    this._data = this._data || {};
    return this._data;
  }).property(),

  _data: null,

  init: function() {
    set(this, 'currentState', DS.RootState.empty);
    this._super();
    this._setup();
  },

  _setup: function() {
    this._changesToSync = {};
    this._deferredTriggers = [];
    this._relationships = {};
  },

  send: function(name, context) {
    var currentState = get(this, 'currentState');

    if (!currentState[name]) {
      this._unhandledEvent(currentState, name, context);
    }

    return currentState[name](this, context);
  },

  transitionTo: function(name) {
    // POSSIBLE TODO: Remove this code and replace with
    // always having direct references to state objects

    var pivotName = name.split(".", 1),
        currentState = get(this, 'currentState'),
        state = currentState;

    do {
      if (state.exit) { state.exit(this); }
      state = state.parentState;
    } while (!state.hasOwnProperty(pivotName));

    var path = name.split(".");

    var setups = [], enters = [], i, l;

    for (i=0, l=path.length; i<l; i++) {
      state = state[path[i]];

      if (state.enter) { enters.push(state); }
      if (state.setup) { setups.push(state); }
    }

    for (i=0, l=enters.length; i<l; i++) {
      enters[i].enter(this);
    }

    set(this, 'currentState', state);

    for (i=0, l=setups.length; i<l; i++) {
      setups[i].setup(this);
    }
  },

  _unhandledEvent: function(state, name, context) {
    var errorMessage = "Attempted to handle event `" + name + "` ";
    errorMessage    += "on " + String(this) + " while in state ";
    errorMessage    += state.stateName + ". ";

    if (context !== undefined) {
      errorMessage  += "Called with " + Ember.inspect(context) + ".";
    }

    throw new Ember.Error(errorMessage);
  },

  withTransaction: function(fn) {
    var transaction = get(this, 'transaction');
    if (transaction) { fn(transaction); }
  },

  loadingData: function() {
    this.send('loadingData');
  },

  loadedData: function() {
    this.send('loadedData');
  },

  pushedData: function() {
    this.send('pushedData');
  },

  deleteRecord: function() {
    this.send('deleteRecord');
  },

  unloadRecord: function() {
    Ember.assert("You can only unload a loaded, non-dirty record.", !get(this, 'isDirty'));

    this.send('unloadRecord');
  },

  clearRelationships: function() {
    this.eachRelationship(function(name, relationship) {
      if (relationship.kind === 'belongsTo') {
        set(this, name, null);
      } else if (relationship.kind === 'hasMany') {
        this.clearHasMany(relationship);
      }
    }, this);
  },

  updateRecordArrays: function() {
    var store = get(this, 'store');
    if (store) {
      store.dataWasUpdated(this.constructor, this);
    }
  },

  adapterWillCommit: function() {
    this.send('willCommit');
  },

  /**
    If the adapter did not return a hash in response to a commit,
    merge the changed attributes and relationships into the existing
    saved data.

    @method adapterDidCommit
  */
  adapterDidCommit: function() {
    this.send('didCommit');
    this.updateRecordArraysLater();
  },

  adapterDidDirty: function() {
    this.send('becomeDirty');
    this.updateRecordArraysLater();
  },

  dataDidChange: Ember.observer(function() {
    this.reloadHasManys();
  }, 'data'),

  reloadHasManys: function() {
    var relationships = get(this.constructor, 'relationshipsByName');
    this.updateRecordArraysLater();
    relationships.forEach(function(name, relationship) {
      if (relationship.kind === 'hasMany') {
        this.hasManyDidChange(relationship.key);
      }
    }, this);
  },

  hasManyDidChange: function(key) {
    var hasMany = this._relationships[key];

    if (hasMany) {
      var type = get(this.constructor, 'relationshipsByName').get(key).type;
      var store = get(this, 'store');
      var records = this._data[key] || [];

      set(hasMany, 'content', Ember.A(records));
      set(hasMany, 'isLoaded', true);
      hasMany.trigger('didLoad');
    }
  },

  updateRecordArraysLater: function() {
    Ember.run.once(this, this.updateRecordArrays);
  },

  setupData: function(data) {
    this._data = data || { id: null };

    if (data) { this.pushedData(); }

    this.send('willSetupData');

    this.suspendRelationshipObservers(function() {
      this.notifyPropertyChange('data');
    });

    this.send('didSetupData');
  },

  materializeId: function(id) {
    set(this, 'id', id);
  },

  materializeAttributes: function(attributes) {
    Ember.assert("Must pass a hash of attributes to materializeAttributes", !!attributes);
    merge(this._data, attributes);
  },

  materializeAttribute: function(name, value) {
    this._data[name] = value;
  },

  updateHasMany: function(name, records) {
    this._data[name] = records;
    this.hasManyDidChange(name);
  },

  rollback: function() {
    this._setup();
    this.send('becameClean');

    this.suspendRelationshipObservers(function() {
      this.notifyPropertyChange('data');
    });
  },

  toStringExtension: function() {
    return get(this, 'id');
  },

  /**
    The goal of this method is to temporarily disable specific observers
    that take action in response to application changes.

    This allows the system to make changes (such as materialization and
    rollback) that should not trigger secondary behavior (such as setting an
    inverse relationship or marking records as dirty).

    The specific implementation will likely change as Ember proper provides
    better infrastructure for suspending groups of observers, and if Array
    observation becomes more unified with regular observers.

    @method suspendRelationshipObservers
    @private
    @param callback
    @param binding
  */
  suspendRelationshipObservers: function(callback, binding) {
    var observers = get(this.constructor, 'relationshipNames').belongsTo;
    var self = this;

    try {
      this._suspendedRelationships = true;
      Ember._suspendObservers(self, observers, null, 'belongsToDidChange', function() {
        Ember._suspendBeforeObservers(self, observers, null, 'belongsToWillChange', function() {
          callback.call(binding || self);
        });
      });
    } finally {
      this._suspendedRelationships = false;
    }
  },

  becameInFlight: function() {
  },

  /**
    @method resolveOn
    @private
    @param successEvent
  */
  resolveOn: function(successEvent) {
    var model = this;

    return new Ember.RSVP.Promise(function(resolve, reject) {
      function success() {
        this.off('becameError', error);
        this.off('becameInvalid', error);
        resolve(this);
      }
      function error() {
        this.off(successEvent, success);
        reject(this);
      }

      model.one(successEvent, success);
      model.one('becameError', error);
      model.one('becameInvalid', error);
    });
  },

  /**
    Save the record.

    @method save
  */
  save: function() {
    this.get('store').scheduleSave(this);

    return this.resolveOn('didCommit');
  },

  /**
    Reload the record from the adapter.

    This will only work if the record has already finished loading
    and has not yet been modified (`isLoaded` but not `isDirty`,
    or `isSaving`).

    @method reload
  */
  reload: function() {
    this.send('reloadRecord');

    return this.resolveOn('didReload');
  },

  // FOR USE DURING COMMIT PROCESS

  adapterDidUpdateAttribute: function(attributeName, value) {

    // If a value is passed in, update the internal attributes and clear
    // the attribute cache so it picks up the new value. Otherwise,
    // collapse the current value into the internal attributes because
    // the adapter has acknowledged it.
    if (value !== undefined) {
      get(this, 'data')[attributeName] = value;
      this.notifyPropertyChange(attributeName);
    } else {
      value = get(this, attributeName);
      get(this, 'data')[attributeName] = value;
    }

    this.updateRecordArraysLater();
  },

  adapterDidInvalidate: function(errors) {
    this.send('becameInvalid', errors);
  },

  adapterDidError: function() {
    this.send('becameError');
  },

  /**
    Override the default event firing from Ember.Evented to
    also call methods with the given name.

    @method trigger
    @private
    @param name
  */
  trigger: function(name) {
    Ember.tryInvoke(this, name, [].slice.call(arguments, 1));
    this._super.apply(this, arguments);
  },

  triggerLater: function() {
    this._deferredTriggers.push(arguments);
    once(this, '_triggerDeferredTriggers');
  },

  _triggerDeferredTriggers: function() {
    for (var i=0, l=this._deferredTriggers.length; i<l; i++) {
      this.trigger.apply(this, this._deferredTriggers[i]);
    }
  }
});

// Helper function to generate store aliases.
// This returns a function that invokes the named alias
// on the default store, but injects the class as the
// first parameter.
var storeAlias = function(methodName) {
  return function() {
    var store = get(DS, 'defaultStore'),
        args = [].slice.call(arguments);

    args.unshift(this);
    Ember.assert("Your application does not have a 'Store' property defined. Attempts to call '" + methodName + "' on model classes will fail. Please provide one as with 'YourAppName.Store = DS.Store.extend()'", !!store);
    return store[methodName].apply(store, args);
  };
};

DS.Model.reopenClass({

  /**
    Alias DS.Model's `create` method to `_create`. This allows us to create DS.Model
    instances from within the store, but if end users accidentally call `create()`
    (instead of `createRecord()`), we can raise an error.

    @method _create
    @private
    @static
  */
  _create: DS.Model.create,

  /**
    Override the class' `create()` method to raise an error. This prevents end users
    from inadvertently calling `create()` instead of `createRecord()`. The store is
    still able to create instances by calling the `_create()` method.

    @method create
    @private
    @static
  */
  create: function() {
    throw new Ember.Error("You should not call `create` on a model. Instead, call `createRecord` with the attributes you would like to set.");
  },

  /**
    See `DS.Store.find()`.

    @method find
    @param {Object|String|Array|null} query A query to find records by.
  */
  find: storeAlias('find'),

  /**
    See `DS.Store.all()`.

    @method all
    @return {DS.RecordArray}
  */
  all: storeAlias('all'),

  /**
    See `DS.Store.findQuery()`.

    @method query
    @param {Object} query an opaque query to be used by the adapter
    @return {DS.AdapterPopulatedRecordArray}
  */
  query: storeAlias('findQuery'),

  /**
    See `DS.Store.filter()`.

    @method filter
    @param {Function} filter
    @return {DS.FilteredRecordArray}
  */
  filter: storeAlias('filter'),

  /**
    See `DS.Store.createRecord()`.

    @method createRecord
    @param {Object} properties a hash of properties to set on the
      newly created record.
    @return DS.Model
  */
  createRecord: storeAlias('createRecord')
});
