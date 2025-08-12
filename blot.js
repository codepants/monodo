function chunkApp() {
  return {
    supabaseUrl: 'https://tqsbgpafbdgeikbjksrd.supabase.co',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxc2JncGFmYmRnZWlrYmprc3JkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzQxMDY4MzYsImV4cCI6MjA0OTY4MjgzNn0.b65CCd0f9JvWIdAWcs-TWfYubzY964uIQcpWHwpa9Lg',
    supabase: null,
    chunks: [],
    newChunkContent: '',
    user: null,
    _initialized: false,
    latestRowId: null,
    showAddChunk: false,
    editingChunkId: null,
    insertingNew: false,
    _insertingRowLock: false,
    projectStatus: '',
    projectObas: '',
    projectActionTime: '',
    obasText: '',
    showObasText: false,
    showFragmentPopup: false,
    fragmentOutput: 'waiting',
    _lastStatusCheck: '',
    _lastFetchTime: 0,
    projectPollInterval: null,
    projectPollIntervalMs: 5000,

    async init() {
      console.log('init entered')
      if (this._initialized) {console.log('already init');return;}
      this._initialized = true;
      this.supabase = window.supabase.createClient(this.supabaseUrl, this.supabaseKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true
        },
        realtime: {
          params: {
            eventsPerSecond: 1
          }
        }
      });
      console.log('Supabase client initialized');

      // Check for existing session
      const { data: { session } } = await this.supabase.auth.getSession();
      if (session && session.user) {
        console.log('User session found, fetching data...');
        this.user = session.user;
        this._lastFetchTime = Date.now(); // Track first fetch time
        // await this.fetchProjectForUser();
        await this.fetchChunks();
        this.startProjectPolling();
        
        // --- Supabase Realtime subscription for project status changes ---
        this.supabase
          .channel('project-changes')
          .on('postgres_changes', {
            event: '*', // Listen to all events
            schema: 'public',
            table: 'project',
          }, async (payload) => {
            console.log('Change received!', payload);
            // Only refetch if the change is for the current user's project
            if (payload.new && payload.new.owner === this.user.email) {
              console.log('fetch at change receive');
              await this.fetchProjectForUser();
            }
          })
          .subscribe();
        // --- End Realtime subscription ---
      }
      // Listen for login events
      this.supabase.auth.onAuthStateChange(async (event, session) => {
        if (session && session.user) {
          this.user = session.user;
          console.log('fetch at login')
          await this.fetchProjectForUser();
          this.fetchChunks();
          this.startProjectPolling();
        } else {
          this.user = null;
          this.stopProjectPolling();
        }
      });
    },

    async signInWithGoogle() {
      console.log('Attempting Google sign-in with redirect to:', window.location.origin + '/blot');
      const { data, error } = await this.supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + '/blot'
        }
      });
      
      if (error) {
        console.error('Google sign-in error:', error);
      } else {
        console.log('Google sign-in initiated:', data);
      }
    },

    async signOut() {
      await this.supabase.auth.signOut();
      this.user = null;
      this.stopProjectPolling();
    },

    async fetchChunks() {
      if (!this.supabase) return;
      let { data, error } = await this.supabase
        .from('chunk')
        .select('*')
        .order('chunk_index', { ascending: true });
      if (!error) {
        this.chunks = data;
        this.updateObas();
      }
    },

    async fetchProjectForUser() {
      console.log("server ping")
      console.log(this.user);
      console.log(this.user.email);
      if (!this.user || !this.user.email) {
        this.projectStatus = '';
        this.projectObas = '';
        this.projectActionTime = '';
        return;
      }
      console.log('Fetching project data...')
      let { data, error } = await this.supabase
        .from('project')
        .select('status, obas, action_time')
        .eq('owner', this.user.email)
        .single()
        .abortSignal(AbortSignal.timeout(2000)); // 2 second timeout

      console.log("Data received:", data);
      console.log("Error:", error);

      if (!error && data) {
        const prevStatus = this.projectStatus;
        this.projectStatus = data.status || '';
        this.projectObas = data.obas || '';
        this.projectActionTime = data.action_time || null;

        console.log("Current status:", this.projectStatus);

        // Check if status is 'done'
        if (this.projectStatus === 'done') {
          // Check if we haven't shown it before or if the content has changed
          this.showFragmentPopupDone();
        }
      } else {
        console.error("Failed to fetch project data:", error);
        // Only reset if there's an actual error, not if it's just empty data
        if (error) {
          this.projectStatus = 'Error: ' + (error.message || 'No project found for this user');
          this.projectObas = '';
          this.projectActionTime = '';
        }
      }
    },

    async addChunk() {
      if (!this.supabase || !this.newChunkContent.trim()) return;
      let maxIndex = this.chunks.length ? Math.max(...this.chunks.map(c => c.chunk_index)) : 0;
      let { data, error } = await this.supabase
        .from('chunk')
        .insert({
          chunk_content: this.newChunkContent,
          chunk_select: true,
          chunk_index: maxIndex + 1,
          verbosity: 4,
          chunk_owner: this.user && this.user.email ? this.user.email : null
        })
        .select();
      if (error) {
        alert('Error inserting chunk: ' + (error.message || JSON.stringify(error)));
        return;
      }
      if (data && data.length) {
        this.chunks.push(data[0]);
        this.chunks.sort((a, b) => a.chunk_index - b.chunk_index);
        this.newChunkContent = '';
        this.latestRowId = data[0].chunk_id;
        this.updateObas();
      }
    },

    async deleteChunk(chunk) {
      if (!this.supabase) {console.log("delete no sup");return;}
      await this.supabase.from('chunk').delete().eq('chunk_id', chunk.chunk_id);
      this.chunks = this.chunks.filter(c => c.chunk_id !== chunk.chunk_id);
      await this.reindexChunks();
      this.updateObas();
    },

    async moveChunk(idx, dir) {
      let newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= this.chunks.length) return;
      let a = this.chunks[idx];
      let b = this.chunks[newIdx];
      let temp = a.chunk_index;
      a.chunk_index = b.chunk_index;
      b.chunk_index = temp;
      await this.supabase.from('chunk').update({ chunk_index: a.chunk_index }).eq('chunk_id', a.chunk_id);
      await this.supabase.from('chunk').update({ chunk_index: b.chunk_index }).eq('chunk_id', b.chunk_id);
      this.chunks.sort((x, y) => x.chunk_index - y.chunk_index);
      this.latestRowId = a.chunk_id;
      this.updateObas();
    },

    async toggleSelect(chunk) {
      chunk.chunk_select = !chunk.chunk_select;
      await this.supabase.from('chunk').update({ chunk_select: chunk.chunk_select }).eq('chunk_id', chunk.chunk_id);
    },

    async setVerbosity(chunk, value) {
      const verbosity = parseInt(value);
      if (isNaN(verbosity) || verbosity < 1 || verbosity > 10) return;

      chunk.verbosity = verbosity;
      await this.supabase.from('chunk').update({ verbosity: verbosity }).eq('chunk_id', chunk.chunk_id);
    },

    async reindexChunks() {
      for (let i = 0; i < this.chunks.length; i++) {
        let c = this.chunks[i];
        if (c.chunk_index !== i + 1) {
          c.chunk_index = i + 1;
          await this.supabase.from('chunk').update({ chunk_index: c.chunk_index }).eq('chunk_id', c.chunk_id);
        }
      }
      this.chunks.sort((a, b) => a.chunk_index - b.chunk_index);
      this.updateObas();
    },

    updateObas: async function() {
      // Concatenate chunk_content in chunk_index order
      if (!this.chunks || !this.chunks.length) {
        this.obasText = '';
        return;
      }
      // Sort to be sure
      const sorted = [...this.chunks].sort((a, b) => a.chunk_index - b.chunk_index);
      this.obasText = sorted.map(c => c.chunk_content).join('\n');
      
      if (this.user && this.user.email) {
        await this.supabase.from('project').update({ status: "pending", obas: this.obasText }).eq('owner', this.user.email);
      }
    },

    get displayName() {
      if (!this.user) return 'guest';
      if (this.user.user_metadata && this.user.user_metadata.full_name) return this.user.user_metadata.full_name;
      if (this.user.email) return this.user.email;
      return 'guest';
    },

    get displayEmail() {
      if (!this.user) return 'guest';
      if (this.user.email) return this.user.email;
      return 'guest';
    },

    enableEdit(chunk) {
      this.editingChunkId = chunk.chunk_id;
      this.$nextTick(() => {
        // Focus the cell for editing
        const row = document.querySelector(`tr[tabindex='0'] td[contenteditable]`);
        if (row) row.focus();
      });
    },

    async saveEdit(chunk, event) {
      const newContent = event.target.innerText;
      if (chunk.chunk_content !== newContent) {
        chunk.chunk_content = newContent;
        await this.supabase.from('chunk').update({ chunk_content: newContent }).eq('chunk_id', chunk.chunk_id);
        this.updateObas();
      }
      this.editingChunkId = null;
    },

    cancelEdit() {
      this.editingChunkId = null;
    },

    startInsertRow() {
      this.insertingNew = true;
      this.$nextTick(() => {
        if (this.$refs.insertInput) {
          this.$refs.insertInput.innerText = '';
          this.$refs.insertInput.focus();
        }
      });
    },

    async saveInsertRow(event) {
      // Only save on Enter, not on blur
      if (event.type === 'blur') return;
      const value = event.target.innerText.trim();
      if (value.length > 0 && !this._insertingRowLock) {
        this._insertingRowLock = true;
        let maxIndex = this.chunks.length ? Math.max(...this.chunks.map(c => c.chunk_index)) : 0;
        let { data, error } = await this.supabase
          .from('chunk')
          .insert({
            chunk_content: value,
            chunk_select: true,
            chunk_index: maxIndex + 1,
            verbosity: 5,
            chunk_owner: this.user && this.user.email ? this.user.email : null
          })
          .select();
        if (!error && data && data.length) {
          this.chunks.push(data[0]);
          this.chunks.sort((a, b) => a.chunk_index - b.chunk_index);
          this.latestRowId = data[0].chunk_id;
          this.updateObas();
        }
        this._insertingRowLock = false;
      }
      this.insertingNew = false;
    },

    cancelInsertRow() {
      this.insertingNew = false;
    },

    formatActionTime(ts) {
      if (!ts) return 'unknown';
      // Try to parse as ISO string or timestamp
      let d = new Date(ts);
      if (isNaN(d.getTime())) return 'unknown';
      return d.toLocaleString();
    },

    submitObas: async function() {
      if (this.user && this.user.email) {
        await this.supabase.from('project').update({ status: 'pending', obas: this.obasText }).eq('owner', this.user.email);
      }
    },

    toggleObasView: function() {
      this.showObasText = !this.showObasText;
    },

    startProjectPolling() {
      // Prevent multiple intervals
      this.stopProjectPolling();
      // Only poll if user is logged in
      if (!this.user) return;
      this.projectPollInterval = setInterval(async () => {
        // console.log('someday')
        // await this.fetchProjectForUser();
      }, this.projectPollIntervalMs);
    },

    stopProjectPolling() {
      if (this.projectPollInterval) {
        clearInterval(this.projectPollInterval);
        this.projectPollInterval = null;
      }
    },

    showFragmentPopupDone() {
      // Add missing method that was referenced in fetchProjectForUser
      this.showFragmentPopup = true;
      const container = document.getElementById('fragmentContentContainer');
      if (container) {
        container.innerHTML = this.projectObas || 'No content available';
      }
    },

    closeFragmentPopup() {
      this.showFragmentPopup = false;
    }
  }
}