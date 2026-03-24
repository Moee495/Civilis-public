import { Request, Response, NextFunction } from 'express';

/**
 * Custom error classes for application-level errors
 */
export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400);
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class AuthError extends AppError {
  constructor(message: string) {
    super(message, 401);
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

/**
 * Wraps async route handlers to catch errors and pass them to the error handler
 * Eliminates the need for try/catch blocks in every route
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) => (req: Request, res: Response, next: NextFunction) => {
  return Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Global error handler middleware
 * Must be registered last in the middleware chain
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const now = new Date().toISOString();

  // Default error properties
  let statusCode = 500;
  let message = 'Internal Server Error';
  let details: string | undefined;

  // Handle custom AppError instances
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
  }
  // Handle validation errors from external libraries
  else if (err.name === 'ValidationError' || err.statusCode === 400) {
    statusCode = 400;
    message = err.message || 'Validation failed';
    details = err.details || err.message;
  }
  // Handle not found errors
  else if (err.name === 'NotFoundError' || err.statusCode === 404) {
    statusCode = 404;
    message = err.message || 'Resource not found';
  }
  // Handle auth errors
  else if (err.name === 'AuthError' || err.statusCode === 401) {
    statusCode = 401;
    message = err.message || 'Unauthorized';
  }
  // Handle generic errors
  else if (err instanceof Error) {
    message = err.message;
    // Don't expose internal error details in production
    if (process.env.NODE_ENV !== 'production') {
      details = err.stack;
    }
  }

  // Log error with timestamp
  console.error(`[${now}] ERROR (${statusCode}): ${message}`);
  if (details) {
    console.error(`Details: ${details}`);
  }

  // Send consistent JSON error response
  res.status(statusCode).json({
    error: message,
    code: statusCode,
    ...(details && { details }),
    timestamp: now,
  });
}

/**
 * Handles 404 Not Found errors
 * Register this middleware after all other routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  const message = `Route not found: ${req.method} ${req.path}`;
  res.status(404).json({
    error: message,
    code: 404,
    timestamp: new Date().toISOString(),
  });
}
