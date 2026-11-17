import type { Models } from "@earendil-works/pi-ai";

export function withStreamSimple(models: Models, streamSimple: Models["streamSimple"]): Models {
  // ModelRuntime implements these as prototype methods; spreading it drops them.
  // Preserve its receiver (provider/auth state) while replacing the chat paths.
  return {
    getProviders: models.getProviders.bind(models),
    getProvider: models.getProvider.bind(models),
    getModels: models.getModels.bind(models),
    getModel: models.getModel.bind(models),
    getModelsOfType: models.getModelsOfType.bind(models),
    getModelOfType: models.getModelOfType.bind(models),
    getAllModels: models.getAllModels.bind(models),
    refresh: models.refresh.bind(models),
    checkAuth: models.checkAuth.bind(models),
    getAvailable: models.getAvailable.bind(models),
    getAvailableOfType: models.getAvailableOfType.bind(models),
    getAllAvailable: models.getAllAvailable.bind(models),
    getAuth: models.getAuth.bind(models),
    login: models.login.bind(models),
    logout: models.logout.bind(models),
    stream: models.stream.bind(models),
    complete: models.complete.bind(models),
    streamDeferred: models.streamDeferred.bind(models),
    fetchDeferred: models.fetchDeferred.bind(models),
    cancelDeferred: models.cancelDeferred.bind(models),
    generateImages: models.generateImages.bind(models),
    classify: models.classify.bind(models),
    streamSimple,
    completeSimple: (model, request, options) => streamSimple(model, request, options).result(),
  };
}
