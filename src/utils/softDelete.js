const softDeletePlugin = (schema) => {
  schema.add({
    deletedAt: {
      type: Date,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  });

  schema.pre(['find', 'findOne', 'countDocuments', 'findOneAndUpdate'], function () {
    if (!this.getFilter().hasOwnProperty('isDeleted')) {
      this.where({ isDeleted: false });
    }
  });

  schema.methods.softDelete = async function () {
    this.isDeleted = true;
    this.deletedAt = new Date();
    return this.save();
  };

  schema.methods.restore = async function () {
    this.isDeleted = false;
    this.deletedAt = null;
    return this.save();
  };
};

export default softDeletePlugin;
