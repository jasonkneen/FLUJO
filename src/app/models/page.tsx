import { Suspense } from 'react';
import dynamicImport from 'next/dynamic';
import { Box, Typography } from '@mui/material';
import { createLogger } from '@/utils/logger';
import * as serverAdapter from '@/app/api/model/backend-model-adapter';
import Spinner from '@/frontend/components/shared/Spinner';

// Use dynamic import to prevent SSR issues with client-side code
const ModelClient = dynamicImport(() => import('./ModelClient'), {
  loading: () => <Spinner />
});

const log = createLogger('app/models/page');

export const dynamic = 'force-dynamic'; // Ensure dynamic rendering

// Async server component
async function ModelsPage() {
  log.debug('Rendering ModelsPage');
  
  try {
    // Fetch models on the server using the server adapter
    const models = await serverAdapter.loadModels();
    log.debug('Models loaded successfully', { count: models.length });
    
    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Box
          sx={{
            p: 2,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Typography variant="h5">Models</Typography>
        </Box>
        <Box sx={{ p: 2, flex: 1, overflow: 'auto' }}>
          <Suspense fallback={<Spinner />}>
            <ModelClient initialModels={models} />
          </Suspense>
        </Box>
      </Box>
    );
  } catch (error) {
    log.error('Error loading models:', error);
    throw error; // This will be caught by the error boundary
  }
}

export default ModelsPage;
