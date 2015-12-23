/*jslint node: true */
'use strict';

/**
 * Barrels: Simple fixtures for Sails.js
 */

/**
 * Dependencies
 */
var fs = require('fs');
var path = require('path');
var async = require('async');
var _ = require('lodash');

/**
 * Barrel.populate options
 * @typedef {{autoAssociations: boolean, purgeExistsData: boolean}} Options for {@link Barrels.populate}
 * @property {boolean} autoAssociations - Indicate that .populate should automatically associate based on the order in the fixture files
 * @property {boolean} purgeExistsData - Indicate that .populate should removing any existing data from the collection corresponding to the fixture
 */
var DEFAULT_POPULATE_OPTIONS = {
	autoAssociations: true,
	purgeExistsData: true
};

module.exports = Barrels;

/**
 * Barrels module
 * @param {string} sourceFolder defaults to <project root>/test/fixtures
 */
function Barrels(sourceFolder) {
	if (!(this instanceof Barrels))
		return new Barrels(sourceFolder);

	// Fixture objects loaded from the JSON files
	this.data = {};

	// Map fixture positions in JSON files to the real DB IDs
	this.idMap = {};

	// The list of associations by model
	this.associations = {};

	// Load the fixtures
	sourceFolder = sourceFolder || process.cwd() + '/test/fixtures';
	var files = fs.readdirSync(sourceFolder);

	for (var i = 0; i < files.length; i++) {
		if (['.json', '.js'].indexOf(path.extname(files[i]).toLowerCase()) !== -1) {
			var modelName = path.basename(files[i]).split('.')[0].toLowerCase();
			this.data[modelName] = require(path.join(sourceFolder, files[i]));
		}
	}

	// The list of the fixtures model names
	this.modelNames = Object.keys(this.data);
}

/**
 * Add associations
 * @param {function} done callback
 */
Barrels.prototype.associate = function (collections, done) {
	if (!_.isArray(collections)) {
		done = collections;
		collections = this.modelNames;
	}
	var that = this;

	// Add associations whenever needed
	async.each(collections, function (modelName, nextModel) {
		var Model = sails.models[modelName];
		if (Model) {
			var fixtureObjects = _.cloneDeep(that.data[modelName]);
			async.each(fixtureObjects, function (item, nextItem) {
				// Item position in the file
				var itemIndex = fixtureObjects.indexOf(item);

				// Find and associate
				Model.findOne(that.idMap[modelName][itemIndex]).exec(function (err, model) {
					if (err)
						return nextItem(err);

					// Pick associations only
					item = _.pick(item, Object.keys(that.associations[modelName]));
					async.each(Object.keys(item), function (attr, nextAttr) {
						var association = that.associations[modelName][attr];
						// Required associations should have beed added earlier
						if (association.required)
							return nextAttr();
						var joined = association[association.type];

						if (!_.isArray(item[attr]))
							model[attr] = that.idMap[joined][item[attr] - 1];
						else {
							for (var j = 0; j < item[attr].length; j++) {
								model[attr].add(that.idMap[joined][item[attr][j] - 1]);
							}
						}

						model.save(function (err) {
							if (err)
								return nextAttr(err);

							nextAttr();
						});
					}, nextItem);
				});
			}, nextModel);
		} else {
			nextModel();
		}
	}, done);
};

/**
 * Put loaded fixtures in the database, associations excluded
 * @param {array} collections optional list of collections to populate
 * @param {function} done callback
 * @param {DEFAULT_POPULATE_OPTIONS} _options_ - Options for populate fixtures
 */
Barrels.prototype.populate = function (collections, done, _options_) {
	if (!_.isArray(collections)) {
		_options_ = done;
		done = collections;
		collections = this.modelNames;
	}
	else {
		_.each(collections, function (collection) {
			collection = collection.toLowerCase();
		});
	}

	var options = _.extend({}, DEFAULT_POPULATE_OPTIONS);

	// backward capability
	if(_.isObject(_options_)){
		_.extend(options, _options_);
	}
	else{
		_.extend(options, {autoAssociations: !(_options_ === false)});
	}

	var that = this;

	async.each(collections, _populate,
		function (err) {
			if (err)
				return done(err);

			// Create associations if requested
			if (options.autoAssociations)
				return that.associate(collections, done);

			done();
		});

	/**
	 * Populate each table / collection
	 * TODO Looks that some refactoring could be doing.
	 * @param modelName
	 * @param nextModel
	 */
	function _populate(modelName, nextModel) {
		var Model = sails.models[modelName];
		if (Model) {
			if (options.purgeExistsData) {
				// Cleanup existing data in the table / collection
				Model.destroy().exec(insertFixtures);
			} else {
				insertFixtures();
			}
		} else {
			nextModel();
		}

		function insertFixtures(err) {
			if (err)
				return nextModel(err);

			// Save model's association information
			that.associations[modelName] = {};
			for (var i = 0; i < Model.associations.length; i++) {
				var alias = Model.associations[i].alias;
				that.associations[modelName][alias] = Model.associations[i];
				that.associations[modelName][alias].required = !!(Model._validator.validations[alias].required);
			}

			// Insert all the fixture items
			that.idMap[modelName] = [];
			var fixtureObjects = _.cloneDeep(that.data[modelName]);
			async.each(fixtureObjects, function (item, nextItem) {
				// Item position in the file
				var itemIndex = fixtureObjects.indexOf(item);

				for (var alias in that.associations[modelName]) {
					if (that.associations[modelName][alias].required) {
						// With required associations present, the associated fixtures
						// must be already loaded, so we can map the ids
						var collectionName = that.associations[modelName][alias].collection; // many-to-many
						var associatedModelName = that.associations[modelName][alias].model; // one-to-many

						if ((_.isArray(item[alias])) && (collectionName)) {
							if (!that.idMap[collectionName])
								return nextItem(new Error('Please provide a loading order acceptable for required associations'));
							for (var i = 0; i < item[alias].length; i++) {
								item[alias][i] = that.idMap[collectionName][item[alias][i] - 1];
							}
						} else if (associatedModelName) {
							if (!that.idMap[associatedModelName])
								return nextItem(new Error('Please provide a loading order acceptable for required associations'));
							item[alias] = that.idMap[associatedModelName][item[alias] - 1];
						}
					} else if (options.autoAssociations) {
						// The order is not important, so we can strip
						// associations data and associate later
						item = _.omit(item, alias);
					}
				}

				// Insert
				Model.create(item).exec(function (err, model) {
					if (err)
						return nextItem(err);

					// Primary key mapping
					that.idMap[modelName][itemIndex] = model[Model.primaryKey];

					nextItem();
				});
			}, nextModel);
		}
	}
};
