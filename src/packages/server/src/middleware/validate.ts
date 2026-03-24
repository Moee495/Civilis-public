import { Request, Response, NextFunction } from 'express';
import { ValidationError } from './errorHandler';

/**
 * Field validation rule definition
 */
interface FieldRule {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  enum?: (string | number)[];
  custom?: (value: any) => boolean | string;
}

/**
 * Schema definition - maps field names to their validation rules
 */
type ValidationSchema = Record<string, FieldRule>;

/**
 * Validates a single field against its rule
 */
function validateField(
  fieldName: string,
  value: any,
  rule: FieldRule
): string | null {
  // Check if field is required but missing
  if (rule.required && (value === undefined || value === null || value === '')) {
    return `Field "${fieldName}" is required`;
  }

  // If not required and no value, skip further validation
  if (!rule.required && (value === undefined || value === null)) {
    return null;
  }

  // Check type
  const valueType = Array.isArray(value) ? 'array' : typeof value;
  if (valueType !== rule.type) {
    return `Field "${fieldName}" must be of type ${rule.type}, got ${valueType}`;
  }

  // String-specific validations
  if (rule.type === 'string' && typeof value === 'string') {
    if (rule.min !== undefined && value.length < rule.min) {
      return `Field "${fieldName}" must have minimum length ${rule.min}`;
    }
    if (rule.max !== undefined && value.length > rule.max) {
      return `Field "${fieldName}" must have maximum length ${rule.max}`;
    }
    if (rule.pattern && !rule.pattern.test(value)) {
      return `Field "${fieldName}" does not match required pattern: ${rule.pattern}`;
    }
    if (rule.enum && !rule.enum.includes(value)) {
      return `Field "${fieldName}" must be one of: ${rule.enum.join(', ')}`;
    }
  }

  // Number-specific validations
  if (rule.type === 'number' && typeof value === 'number') {
    if (rule.min !== undefined && value < rule.min) {
      return `Field "${fieldName}" must be at least ${rule.min}`;
    }
    if (rule.max !== undefined && value > rule.max) {
      return `Field "${fieldName}" must be at most ${rule.max}`;
    }
    if (rule.enum && !rule.enum.includes(value)) {
      return `Field "${fieldName}" must be one of: ${rule.enum.join(', ')}`;
    }
  }

  // Custom validation function
  if (rule.custom) {
    const customResult = rule.custom(value);
    if (customResult !== true) {
      return typeof customResult === 'string'
        ? customResult
        : `Field "${fieldName}" failed custom validation`;
    }
  }

  return null;
}

/**
 * Middleware factory that validates request body against a schema
 * Returns 400 Bad Request if validation fails
 */
export function validateBody(schema: ValidationSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: string[] = [];

    // Validate each field in the schema
    for (const [fieldName, rule] of Object.entries(schema)) {
      const value = req.body?.[fieldName];
      const error = validateField(fieldName, value, rule);
      if (error) {
        errors.push(error);
      }
    }

    // If there are validation errors, throw ValidationError
    if (errors.length > 0) {
      const errorMessage = errors.join('; ');
      throw new ValidationError(errorMessage);
    }

    // Validation passed, continue to next middleware/route
    next();
  };
}

/**
 * Predefined validation schemas for common endpoints
 */

export const agentSchema: ValidationSchema = {
  name: {
    type: 'string',
    required: true,
    min: 1,
    max: 50,
  },
  agentType: {
    type: 'string',
    required: true,
  },
  config: {
    type: 'object',
    required: false,
  },
  personality: {
    type: 'object',
    required: false,
  },
};

export const signalSchema: ValidationSchema = {
  token: {
    type: 'string',
    required: true,
  },
  direction: {
    type: 'string',
    required: true,
    pattern: /^(up|down)$/,
  },
  changePercent: {
    type: 'number',
    required: true,
  },
  sellerAgentId: {
    type: 'string',
    required: true,
  },
};

export const adviceSchema: ValidationSchema = {
  token: {
    type: 'string',
    required: true,
  },
  action: {
    type: 'string',
    required: true,
  },
  sellerAgentId: {
    type: 'string',
    required: true,
  },
};
