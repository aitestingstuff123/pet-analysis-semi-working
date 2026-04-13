import { AdMob, RewardAdOptions, RewardAdPluginEvents, AdMobRewardItem } from '@capacitor-community/admob';
import { Capacitor } from '@capacitor/core';

export interface CustomRewardedAdOptions {
  onAdLoaded?: () => void;
  onAdFailedToLoad?: (error: string) => void;
  onAdOpened?: () => void;
  onAdClosed?: () => void;
  onUserEarnedReward: (reward: { amount: number; type: string }) => void;
}

class RewardedAdService {
  private isLoaded: boolean = false;
  private isShowing: boolean = false;
  private isInitialized: boolean = false;
  private listenersAdded: boolean = false;

  private async initializeAdMob() {
    if (this.isInitialized || !Capacitor.isNativePlatform()) return;
    try {
      await AdMob.initialize({
        requestTrackingAuthorization: true,
        initializeForTesting: true, // Set to false in production
      });
      this.isInitialized = true;
    } catch (error) {
      console.error("[AdMob] Initialization failed", error);
    }
  }

  public async loadAd(adUnitId: string, options: CustomRewardedAdOptions): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      // WEB SIMULATION FALLBACK
      console.log(`[AdMob Web Sim] Loading rewarded ad for unit: ${adUnitId}`);
      setTimeout(() => {
        this.isLoaded = true;
        console.log(`[AdMob Web Sim] Rewarded ad loaded successfully.`);
        options.onAdLoaded?.();
      }, 1500);
      return;
    }

    // NATIVE ADMOB
    await this.initializeAdMob();

    if (!this.listenersAdded) {
      AdMob.addListener(RewardAdPluginEvents.Loaded, () => {
        this.isLoaded = true;
        console.log("[AdMob] Ad loaded successfully");
        options.onAdLoaded?.();
      });

      AdMob.addListener(RewardAdPluginEvents.FailedToLoad, (error) => {
        this.isLoaded = false;
        console.error("[AdMob] Ad failed to load", error);
        options.onAdFailedToLoad?.(error.message || "Failed to load");
      });

      AdMob.addListener(RewardAdPluginEvents.Showed, () => {
        this.isShowing = true;
        console.log("[AdMob] Ad opened");
        options.onAdOpened?.();
      });

      AdMob.addListener(RewardAdPluginEvents.Dismissed, () => {
        this.isShowing = false;
        this.isLoaded = false;
        console.log("[AdMob] Ad closed");
        options.onAdClosed?.();
      });

      AdMob.addListener(RewardAdPluginEvents.Rewarded, (rewardItem: AdMobRewardItem) => {
        console.log("[AdMob] User earned reward", rewardItem);
        options.onUserEarnedReward({ amount: rewardItem.amount, type: rewardItem.type });
      });

      this.listenersAdded = true;
    }

    try {
      const rewardOptions: RewardAdOptions = {
        adId: adUnitId,
        isTesting: true // Set to false in production
      };
      await AdMob.prepareRewardVideoAd(rewardOptions);
    } catch (error: any) {
      console.error("[AdMob] Failed to prepare ad", error);
      options.onAdFailedToLoad?.(error.message || "Failed to prepare ad");
    }
  }

  public async showAd(options: CustomRewardedAdOptions): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      // WEB SIMULATION FALLBACK
      if (!this.isLoaded) {
        console.error("[AdMob Web Sim] Cannot show ad: Not loaded yet.");
        options.onAdFailedToLoad?.("Ad not loaded");
        return;
      }
      if (this.isShowing) return;
      this.isShowing = true;
      options.onAdOpened?.();
      console.log("[AdMob Web Sim] Rewarded ad opened. User is watching...");
      setTimeout(() => {
        console.log("[AdMob Web Sim] User finished watching ad. Granting reward.");
        options.onUserEarnedReward({ amount: 1, type: 'bonus' });
        this.isShowing = false;
        this.isLoaded = false;
        options.onAdClosed?.();
      }, 5000);
      return;
    }

    // NATIVE ADMOB
    if (!this.isLoaded) {
      console.error("[AdMob] Cannot show ad: Not loaded yet.");
      options.onAdFailedToLoad?.("Ad not loaded");
      return;
    }

    if (this.isShowing) return;

    try {
      await AdMob.showRewardVideoAd();
    } catch (error: any) {
      console.error("[AdMob] Failed to show ad", error);
      options.onAdFailedToLoad?.(error.message || "Failed to show ad");
    }
  }

  public isAdReady(): boolean {
    return this.isLoaded;
  }
}

export const rewardedAdService = new RewardedAdService();
