import { escape } from 'html-escaper';

/**
 * Sanitize text input to prevent XSS attacks
 */
export function sanitizeText(input: string | null | undefined): string {
  if (!input) return '';
  // On the server side, use basic sanitization
  return stripTags(input);
}

/**
 * Strip HTML tags from text
 */
function stripTags(input: string): string {
  // Basic HTML tag stripping for server-side
  return input.replace(/<[^>]*>/g, '');
}

/**
 * Escape HTML entities to prevent XSS
 */
export function escapeHtml(input: string): string {
  return escape(input);
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Sanitize input for database queries to prevent SQL injection
 */
export function sanitizeForQuery(input: string): string {
  // Remove potentially dangerous characters
  return input.replace(/['";\\]/g, '');
}

/**
 * Validate and sanitize price values
 */
export function sanitizePrice(price: number | undefined): number | undefined {
  if (price === undefined) return undefined;
  
  // Ensure price is a finite number within reasonable bounds
  if (!Number.isFinite(price) || price < 0 || price > 100000) {
    return undefined;
  }
  
  return Number(price.toFixed(2));
}

/**
 * Sanitize array inputs to prevent injection
 */
export function sanitizeArrayInput(inputs: string[]): string[] {
  return inputs
    .map(item => item.trim())
    .filter(item => item.length > 0)
    .slice(0, 50); // Limit array size to prevent abuse
}