// Purpose: Compose application-wide providers above routes and loading states.
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { ErrorBoundary } from "react-error-boundary";

import { MainErrorFallback } from "@/components/errors/main";
import { Toaster } from "@openchart/app/components/ui/sonner/sonner";
import { Spinner } from "@/components/ui/spinner";
import { createQueryClient } from "@/lib/react-query/react-query";

type AppProviderProps = {
  children: React.ReactNode;
};

/**
 * Composes shared providers around all app content, including loading states.
 * @example <AppProvider>{children}</AppProvider>
 */
export const AppProvider = ({ children }: AppProviderProps) => {
  const [queryClient] = React.useState(createQueryClient);

  return (
    <React.Suspense
      fallback={
        <div className="flex h-screen w-screen items-center justify-center">
          <Spinner size="xl" />
        </div>
      }
    >
      <ErrorBoundary FallbackComponent={MainErrorFallback}>
        <QueryClientProvider client={queryClient}>
          <Toaster />
          {children}
        </QueryClientProvider>
      </ErrorBoundary>
    </React.Suspense>
  );
};
