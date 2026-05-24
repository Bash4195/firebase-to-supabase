// The Firebase Admin SDK to access Firestore.
const {initializeApp} = require("firebase-admin/app");

initializeApp();

const { onUserCreate, onUserDelete, changeUserEmail } = require("./auth")
const { onRecipeCreate, onRecipeUpdate, onRecipeDelete } = require("./recipes")
const { onCollectionCreate, onCollectionUpdate, onCollectionDelete } = require("./collections")
const { onJunctionCollectionRecipeCreate, onJunctionCollectionRecipeDelete } = require("./junction_collection_recipes")
const { onCollectionShareCreate, onCollectionShareUpdate, onCollectionShareDelete } = require("./collection_shares")

// Auth
exports.onUserCreate = onUserCreate
exports.onUserDelete = onUserDelete
exports.changeUserEmail = changeUserEmail

// Recipes
exports.onRecipeCreate = onRecipeCreate
exports.onRecipeUpdate = onRecipeUpdate
exports.onRecipeDelete = onRecipeDelete

// Collections
exports.onCollectionCreate = onCollectionCreate
exports.onCollectionUpdate = onCollectionUpdate
exports.onCollectionDelete = onCollectionDelete

// Collections recipes
exports.onJunctionCollectionRecipeCreate = onJunctionCollectionRecipeCreate
exports.onJunctionCollectionRecipeDelete = onJunctionCollectionRecipeDelete

// Collection shares
exports.onCollectionShareCreate = onCollectionShareCreate
exports.onCollectionShareUpdate = onCollectionShareUpdate
exports.onCollectionShareDelete = onCollectionShareDelete
