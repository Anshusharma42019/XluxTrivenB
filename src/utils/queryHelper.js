/**
 * Helper to build Mongoose queries from request query parameters.
 * Supports filtering, sorting, field selection, and pagination.
 */
class QueryHelper {
  constructor(model, queryParams) {
    this.model = model;
    this.queryParams = queryParams;
    this.query = null;
  }

  /**
   * Apply filters to the query.
   * Supports basic equality and MongoDB operators like $gt, $lt, $regex.
   */
  filter() {
    const queryObj = { ...this.queryParams };
    const excludedFields = ['page', 'sort', 'sortBy', 'limit', 'fields', 'search'];
    excludedFields.forEach((el) => delete queryObj[el]);

    // Advanced filtering (gt, gte, lt, lte, in, regex)
    let queryStr = JSON.stringify(queryObj);
    queryStr = queryStr.replace(/\b(gt|gte|lt|lte|in|regex|options)\b/g, (match) => `$${match}`);

    const filters = JSON.parse(queryStr);

    // Search query
    if (this.queryParams.search) {
      filters.$or = [
        // This should be customized per model, but here's a generic example for 'name' and 'email'
        { name: { $regex: this.queryParams.search, $options: 'i' } },
        { email: { $regex: this.queryParams.search, $options: 'i' } },
      ];
    }

    this.query = this.model.find(filters);
    return this;
  }

  /**
   * Sort the results based on the 'sort' parameter.
   * Default is '-createdAt'.
   */
  sort() {
    const sortParam = this.queryParams.sortBy || this.queryParams.sort;
    if (sortParam) {
      this.query = this.query.sort(sortParam.split(',').join(' '));
    } else {
      this.query = this.query.sort('-createdAt');
    }
    return this;
  }

  /**
   * Select specific fields to return.
   */
  limitFields() {
    if (this.queryParams.fields) {
      const fields = this.queryParams.fields.split(',').join(' ');
      this.query = this.query.select(fields);
    } else {
      this.query = this.query.select('-__v');
    }
    return this;
  }

  /**
   * Paginate the results based on 'page' and 'limit' parameters.
   */
  async paginate() {
    const page = parseInt(this.queryParams.page, 10) || 1;
    const limit = parseInt(this.queryParams.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const totalResults = await this.model.countDocuments(this.query.getFilter());
    const totalPages = Math.ceil(totalResults / limit);

    this.query = this.query.skip(skip).limit(limit);

    const results = await this.query;

    return {
      results,
      page,
      limit,
      totalPages,
      totalResults,
    };
  }

  /**
   * Execute the query and return the results directly.
   */
  async execute() {
    this.filter().sort().limitFields();
    return await this.paginate();
  }
}

export default QueryHelper;
