class SupabaseConnectionManager {
  constructor(url, key, options = {}) {
    this.url = url;
    this.key = key;
    this.client = null;
    this.isHealthy = false;
    this.lastHealthCheck = 0;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.healthCheckInterval = options.healthCheckInterval || 30000; // 30 seconds
    this.reconnectDelay = options.reconnectDelay || 2000; // 2 seconds
    this.maxReconnectDelay = options.maxReconnectDelay || 30000; // 30 seconds
    this.healthCheckTimer = null;
    this.pendingOperations = new Map();
    this.operationId = 0;
    
    // Event handlers
    this.onHealthChange = options.onHealthChange || (() => {});
    this.onReconnect = options.onReconnect || (() => {});
    this.onError = options.onError || console.error;
    
    this.initialize();
  }

  async initialize() {
    try {
      this.client = window.supabase.createClient(this.url, this.key, {
        auth: {
          autoRefreshToken: true,
          persistSession: true
        },
        realtime: {
          params: {
            eventsPerSecond: 10
          }
        }
      });

      // Test initial connection
      await this.performHealthCheck();
      
      if (this.isHealthy) {
        this.startHealthMonitoring();
        console.log('✅ Supabase connection initialized successfully');
      } else {
        throw new Error('Initial health check failed');
      }
    } catch (error) {
      this.onError('Failed to initialize Supabase:', error);
      this.scheduleReconnect();
    }
  }

  async performHealthCheck() {
    const checkId = Date.now();
    console.log(`🔍 Health check ${checkId}...`);
    
    try {
      // Simple ping query - just get server time
      const { data, error } = await Promise.race([
        this.client.rpc('now').select(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Health check timeout')), 10000)
        )
      ]);

      if (error && error.code !== '42883') { // 42883 = function doesn't exist, which is fine
        // Try alternative health check
        const { data: testData, error: testError } = await this.client
          .from('_supabase_health_check_dummy_table_')
          .select('*')
          .limit(1);
        
        // If table doesn't exist, that's actually good - connection works
        if (testError && testError.code !== 'PGRST106') {
          throw testError;
        }
      }

      const wasUnhealthy = !this.isHealthy;
      this.isHealthy = true;
      this.lastHealthCheck = Date.now();
      this.reconnectAttempts = 0;

      if (wasUnhealthy) {
        console.log('✅ Connection restored');
        this.onHealthChange(true);
        this.onReconnect();
        this.processPendingOperations();
      }

      return true;
    } catch (error) {
      console.warn(`❌ Health check ${checkId} failed:`, error.message);
      const wasHealthy = this.isHealthy;
      this.isHealthy = false;
      
      if (wasHealthy) {
        console.log('🔌 Connection lost, attempting recovery...');
        this.onHealthChange(false);
        this.scheduleReconnect();
      }
      
      return false;
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Max reconnection attempts reached');
      this.onError(new Error('Max reconnection attempts exceeded'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    console.log(`🔄 Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    setTimeout(async () => {
      console.log(`🔄 Reconnect attempt ${this.reconnectAttempts}...`);
      
      try {
        // Create new client instance
        this.client = window.supabase.createClient(this.url, this.key, {
          auth: {
            autoRefreshToken: true,
            persistSession: true
          }
        });

        // Test the new connection
        const isHealthy = await this.performHealthCheck();
        
        if (!isHealthy) {
          this.scheduleReconnect(); // Try again
        }
      } catch (error) {
        console.error('Reconnect attempt failed:', error);
        this.scheduleReconnect();
      }
    }, delay);
  }

  startHealthMonitoring() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      if (Date.now() - this.lastHealthCheck > this.healthCheckInterval) {
        this.performHealthCheck();
      }
    }, this.healthCheckInterval);
  }

  stopHealthMonitoring() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // Main query method with auto-retry and queuing
  async executeQuery(queryFn, options = {}) {
    const operationId = ++this.operationId;
    const maxRetries = options.maxRetries || 3;
    const timeout = options.timeout || 15000;

    // If connection is unhealthy, queue the operation
    if (!this.isHealthy) {
      console.log(`📤 Queuing operation ${operationId} (connection unhealthy)`);
      return new Promise((resolve, reject) => {
        this.pendingOperations.set(operationId, {
          queryFn,
          options,
          resolve,
          reject,
          timestamp: Date.now()
        });
        
        // Clean up old pending operations (older than 2 minutes)
        setTimeout(() => {
          if (this.pendingOperations.has(operationId)) {
            this.pendingOperations.delete(operationId);
            reject(new Error('Operation timed out while waiting for connection'));
          }
        }, 120000);
      });
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Executing operation ${operationId}, attempt ${attempt}/${maxRetries}`);
        
        const result = await Promise.race([
          queryFn(this.client),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Query timeout')), timeout)
          )
        ]);

        console.log(`✅ Operation ${operationId} completed successfully`);
        return result;

      } catch (error) {
        console.warn(`❌ Operation ${operationId} attempt ${attempt} failed:`, error.message);
        
        // Check if it's a connection error
        if (this.isConnectionError(error)) {
          this.isHealthy = false;
          this.onHealthChange(false);
          
          if (attempt === maxRetries) {
            this.scheduleReconnect();
            throw new Error(`Operation failed after ${maxRetries} attempts: ${error.message}`);
          }
          
          // Wait before retry with exponential backoff
          await new Promise(resolve => 
            setTimeout(resolve, 1000 * Math.pow(2, attempt - 1))
          );
        } else {
          // Non-connection error, don't retry
          throw error;
        }
      }
    }
  }

  processPendingOperations() {
    console.log(`📥 Processing ${this.pendingOperations.size} pending operations`);
    
    const operations = Array.from(this.pendingOperations.entries());
    this.pendingOperations.clear();

    operations.forEach(([operationId, operation]) => {
      this.executeQuery(operation.queryFn, operation.options)
        .then(operation.resolve)
        .catch(operation.reject);
    });
  }

  isConnectionError(error) {
    const connectionErrorCodes = [
      'NETWORK_ERROR',
      'TIMEOUT',
      'ECONNREFUSED', 
      'ENOTFOUND',
      'ECONNRESET'
    ];
    
    const connectionErrorMessages = [
      'network error',
      'timeout',
      'connection refused',
      'failed to fetch',
      'network request failed'
    ];

    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.code?.toUpperCase() || '';

    return connectionErrorCodes.includes(errorCode) || 
           connectionErrorMessages.some(msg => errorMessage.includes(msg)) ||
           error.name === 'TypeError' || // Often network errors
           error.name === 'AbortError';
  }

  // Convenience methods that use executeQuery
  async from(table) {
    const result = await this.executeQuery(client => client.from(table));
    return result;
  }

  async auth() {
    return this.client.auth;
  }

  async channel(name) {
    return this.client.channel(name);
  }

  // Status methods
  getStatus() {
    return {
      isHealthy: this.isHealthy,
      lastHealthCheck: this.lastHealthCheck,
      reconnectAttempts: this.reconnectAttempts,
      pendingOperations: this.pendingOperations.size
    };
  }

  // Cleanup
  destroy() {
    this.stopHealthMonitoring();
    this.pendingOperations.clear();
    if (this.client) {
      // Clean up any subscriptions
      this.client.removeAllChannels?.();
    }
  }
}

// Usage in your Alpine.js app:
function chunkApp() {
  return {
    supabaseManager: null,
    connectionStatus: 'connecting',
    
    async init() {
      // Initialize the connection manager
      this.supabaseManager = new SupabaseConnectionManager(
        'https://tqsbgpafbdgeikbjksrd.supabase.co',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxc2JncGFmYmRnZWlrYmprc3JkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzQxMDY4MzYsImV4cCI6MjA0OTY4MjgzNn0.b65CCd0f9JvWIdAWcs-TWfYubzY964uIQcpWHwpa9Lg',
        {
          onHealthChange: (isHealthy) => {
            this.connectionStatus = isHealthy ? 'connected' : 'disconnected';
            console.log('Connection status changed:', this.connectionStatus);
          },
          onReconnect: () => {
            console.log('Reconnected! Refreshing data...');
            this.fetchChunks();
          },
          onError: (error) => {
            console.error('Supabase error:', error);
            this.connectionStatus = 'error';
          }
        }
      );
    },

    // Updated methods using the connection manager
    async fetchChunks() {
      try {
        const result = await this.supabaseManager.executeQuery(
          client => client.from('chunk')
            .select('*')
            .order('chunk_index', { ascending: true })
        );
        
        if (!result.error) {
          this.chunks = result.data;
          this.updateObas();
        }
      } catch (error) {
        console.error('Failed to fetch chunks:', error);
      }
    },

    async addChunk() {
      if (!this.newChunkContent.trim()) return;
      
      try {
        let maxIndex = this.chunks.length ? Math.max(...this.chunks.map(c => c.chunk_index)) : 0;
        
        const result = await this.supabaseManager.executeQuery(
          client => client.from('chunk').insert({
            chunk_content: this.newChunkContent,
            chunk_select: true,
            chunk_index: maxIndex + 1,
            verbosity: 4,
            chunk_owner: this.user?.email || null
          }).select()
        );
        
        if (!result.error && result.data?.length) {
          this.chunks.push(result.data[0]);
          this.chunks.sort((a, b) => a.chunk_index - b.chunk_index);
          this.newChunkContent = '';
          this.latestRowId = result.data[0].chunk_id;
          this.updateObas();
        }
      } catch (error) {
        console.error('Failed to add chunk:', error);
        alert('Failed to add chunk. Please try again.');
      }
    },

    // Get connection status for UI
    get isConnected() {
      return this.connectionStatus === 'connected';
    },

    get connectionIndicator() {
      switch (this.connectionStatus) {
        case 'connected': return '🟢';
        case 'connecting': return '🟡';
        case 'disconnected': return '🔴';
        case 'error': return '❌';
        default: return '⚫';
      }
    }
  }
}