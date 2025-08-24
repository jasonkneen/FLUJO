import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLogger } from '@/utils/logger';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import { MCPToolResponse as ToolResponse, MCPServiceResponse } from '@/shared/types/mcp';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('backend/services/mcp/tools');

/**
 * Normalize tool arguments to ensure we don't pass undefined values to MCP servers
 * This function replaces undefined/null values with appropriate defaults based on expected types
 */
function normalizeToolArguments(args: Record<string, unknown>, toolName: string): Record<string, unknown> {
  if (!args) return {};
  
  const normalizedArgs: Record<string, unknown> = {};
  
  // Process each argument
  for (const key in args) {
    const value = args[key];
    
    // Handle undefined or null values
    if (value === undefined || value === null) {
      log.debug(`Normalizing undefined/null value for parameter '${key}' in tool '${toolName}'`);
      
      // Try to infer the type from the key name
      if (key.includes('number') || key.endsWith('Count') || key.endsWith('Id') || key.endsWith('Limit')) {
        normalizedArgs[key] = 0;
        log.debug(`Using default value 0 for likely number parameter: ${key}`);
      } else if (key.includes('bool') || key.startsWith('is') || key.startsWith('has') || key.startsWith('should')) {
        normalizedArgs[key] = false;
        log.debug(`Using default value false for likely boolean parameter: ${key}`);
      } else if (key.includes('array') || key.endsWith('s') || key.endsWith('List') || key.endsWith('Items')) {
        normalizedArgs[key] = [];
        log.debug(`Using empty array for likely array parameter: ${key}`);
      } else if (key.includes('object') || key.endsWith('Options') || key.endsWith('Config') || key.endsWith('Settings')) {
        normalizedArgs[key] = {};
        log.debug(`Using empty object for likely object parameter: ${key}`);
      } else {
        // Default to empty string for unknown types
        normalizedArgs[key] = '';
        log.debug(`Using empty string for parameter with unknown type: ${key}`);
      }
    } else {
      // For non-undefined/null values, keep the original value
      normalizedArgs[key] = value;
    }
  }
  
  return normalizedArgs;
}

/**
 * List tools available from an MCP server
 */
export async function listServerTools(client: Client | undefined, serverName: string): Promise<{ tools: ToolResponse[], error?: string }> {
  log.debug('Entering listServerTools method');
  if (!client) {
    log.warn(`Server ${serverName} not connected`);
    return { tools: [], error: 'Server not connected' };
  }

  try {
    log.info(`Listing tools for server ${serverName}`);
    const response = await client.listTools();
    log.verbose('Raw response from MCP server:', response);

    const tools = (response.tools || []).map(tool => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || {}
    }));

    log.verbose('Processed tools:', tools);
    return { tools };
  } catch (error) {
    log.warn(`Failed to list tools for server ${serverName}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      tools: [],
      error: errorMessage.includes('Connection timeout')
        ? errorMessage
        : `Failed to list tools: ${errorMessage}`
    };
  }
}

/**
 * Call a tool on an MCP server with support for progress tracking
 */
export async function callTool(
  client: Client | undefined, 
  serverName: string, 
  toolName: string, 
  args: Record<string, unknown>, 
  timeout?: number
): Promise<MCPServiceResponse> {
  log.debug('Entering callTool method');
  if (!client) {
    log.warn(`Server ${serverName} not found`);
    return { 
      success: false, 
      error: `Server ${serverName} not found`,
      statusCode: 404
    };
  }

  try {
    // Resolve any global variable references in the arguments
    log.debug(`Original args for tool ${toolName}:`, args);
    const resolvedArgs = await resolveGlobalVars(args);
    
    // Ensure resolvedArgs is a record before normalizing
    const argsRecord = (typeof resolvedArgs === 'object' && resolvedArgs !== null) 
      ? resolvedArgs as Record<string, unknown> 
      : {};
    
    // Normalize undefined/null values based on parameter types
    // This ensures we don't pass undefined values to MCP servers
    const normalizedArgs = normalizeToolArguments(argsRecord, toolName);
    log.debug(`Normalized args for tool ${toolName}:`, normalizedArgs);
    
    // Generate a progress token for tracking this tool call
    const progressToken = uuidv4();
    log.debug(`Generated progress token: ${progressToken} for tool ${toolName}`);
    
    // Add metadata to the tool call for progress tracking
    const toolCallParams = {
      name: toolName,
      arguments: normalizedArgs as Record<string, unknown>,
      _meta: {
        progressToken
      }
    };
    
    // Handle timeout if specified
    if (timeout !== undefined) {
      log.debug(`Using timeout: ${timeout} seconds for tool ${toolName}`);
      
      if (timeout === -1) {
        // No timeout (infinite)
        log.debug(`No timeout set for tool ${toolName}`);
        const response = await client.callTool(toolCallParams);
        return { 
          success: true, 
          data: response, 
          progressToken 
        };
      } else {
        // Set timeout in milliseconds
        const timeoutMs = timeout * 1000;
        log.debug(`Setting timeout of ${timeoutMs}ms for tool ${toolName}`);
        
        // Create an AbortController for the timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, timeoutMs);
        
        try {
          // Call the tool with timeout
          const response = await Promise.race([
            client.callTool(toolCallParams),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error(`Tool execution timed out after ${timeout} seconds`));
              });
            })
          ]);
          
          // Clear the timeout
          clearTimeout(timeoutId);
          
          return { 
            success: true, 
            data: response, 
            progressToken 
          };
        } catch (error) {
          // Clear the timeout
          clearTimeout(timeoutId);
          
          // Check if it's a timeout error
          if (error instanceof Error && error.message.includes('timed out')) {
            log.warn(`Tool ${toolName} execution timed out after ${timeout} seconds`);
            
            // Try to send a cancellation notification
            try {
              await cancelToolExecution(client, progressToken, `Execution timed out after ${timeout} seconds`);
              log.info(`Sent cancellation notification for timed out tool ${toolName}`);
            } catch (cancelError) {
              log.warn(`Failed to send cancellation notification: ${cancelError instanceof Error ? cancelError.message : 'Unknown error'}`);
            }
            
            // Create a standardized timeout error response
            const timeoutError = {
              success: false, 
              error: `Tool execution timed out after ${timeout} seconds`,
              errorType: 'timeout',
              toolName,
              timeout,
              progressToken,
              statusCode: 408
            };
            
            // We can't directly emit events from the client, but we can log the error
            // which will be captured by the stderr handler in the SSE route
            log.error(JSON.stringify({
              type: 'error',
              source: 'timeout',
              message: `Tool ${toolName} execution timed out after ${timeout} seconds`,
              toolName,
              timeout,
              progressToken
            }));
            
            return timeoutError;
          }
          
          // Re-throw other errors
          throw error;
        }
      }
    } else {
      // No timeout specified, use default behavior (no timeout)
      log.debug(`No timeout specified for tool ${toolName}, using default (no timeout)`);
      const response = await client.callTool(toolCallParams);
      return { 
        success: true, 
        data: response, 
        progressToken 
      };
    }
  } catch (error) {
    log.warn(`Failed to call tool ${toolName} on server ${serverName}:`, error);
    let errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let statusCode = 500;

    // Check for OAuth-related errors
    if (errorMessage.includes('401') || errorMessage.includes('Unauthorized') || 
        errorMessage.includes('invalid_token') || errorMessage.includes('token_expired')) {
      log.info(`OAuth authentication error detected for tool ${toolName} on server ${serverName}`);
      return {
        success: false,
        error: 'OAuth authentication failed or tokens have expired. Please re-authenticate the server.',
        statusCode: 401,
        requiresAuthentication: true
      };
    }

    // Check for 404 errors which might indicate OAuth issues
    if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
      log.info(`404 error detected for tool ${toolName} on server ${serverName} - may indicate OAuth issues`);
      statusCode = 404;
      errorMessage = `Tool endpoint not found (404). This may indicate OAuth authentication issues or the server may not be properly configured.`;
    }

    if (error instanceof McpError) {
      errorMessage = `Failed to call tool: ${errorMessage} (Code: ${error.code})`;
      
      // Map MCP error codes to HTTP status codes
      if (error.code === -32601) { // Method not found
        statusCode = 404;
      } else if (error.code === -32602) { // Invalid params
        statusCode = 400;
      } else if (error.code === -32603) { // Internal error
        statusCode = 500;
      }
    } else {
      errorMessage = `Failed to call tool: ${errorMessage}`;
    }

    return { 
      success: false, 
      error: errorMessage,
      statusCode
    };
  }
}

/**
 * Cancel a tool execution in progress
 */
export async function cancelToolExecution(client: Client, requestId: string, reason: string): Promise<void> {
  log.debug(`Cancelling request ${requestId}: ${reason}`);
  
  try {
    // Send a cancellation notification as per MCP specification
    // Note: This is a custom implementation since the SDK doesn't expose this directly
    const transport = client.transport;
    if (!transport) {
      throw new Error('Client has no transport');
    }
    
    // Create a cancellation notification
    const cancellationNotification = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: {
        requestId,
        reason
      }
    };
    
    // Define a type for transports that support sending messages
    interface SendableTransport {
      send(message: string): Promise<void>;
    }
    
    // Send the notification through the transport
    if ('send' in transport) {
      await (transport as unknown as SendableTransport).send(JSON.stringify(cancellationNotification));
      log.info(`Sent cancellation notification for request ${requestId}`);
    } else {
      throw new Error('Transport does not support sending messages');
    }
  } catch (error) {
    log.error(`Failed to cancel tool execution: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}
