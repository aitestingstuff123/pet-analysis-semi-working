/**
 * Simulated AdMob Rewarded Video Service for Web
 * In a real mobile app, this would use the AdMob SDK.
 * For web, this simulates the loading and reward flow.
 */

export interface RewardedAdOptions {
  onAdLoaded?: () => void;
  onAdFailedToLoad?: (error: string) => void;
  onAdOpened?: () => void;
  onAdClosed?: () => void;
  onUserEarnedReward: (reward: { amount: number; type: string }) => void;
}

class RewardedAdService {
  private isLoaded: boolean = false;
  private isShowing: boolean = false;

  /**
   * Simulates loading a rewarded ad
   */
  public loadAd(adUnitId: string, options: RewardedAdOptions): void {
    console.log(`[AdMob] Loading rewarded ad for unit: ${adUnitId}`);
    
    // Simulate network delay
    setTimeout(() => {
      this.isLoaded = true;
      console.log(`[AdMob] Rewarded ad loaded successfully.`);
      options.onAdLoaded?.();
    }, 1500);
  }

  /**
   * Simulates showing the rewarded ad
   */
  public showAd(options: RewardedAdOptions): void {
    if (!this.isLoaded) {
      console.error("[AdMob] Cannot show ad: Not loaded yet.");
      options.onAdFailedToLoad?.("Ad not loaded");
      return;
    }

    if (this.isShowing) return;

    this.isShowing = true;
    options.onAdOpened?.();
    console.log("[AdMob] Rewarded ad opened. User is watching...");

    // Simulate ad duration (e.g., 5 seconds for demo)
    setTimeout(() => {
      console.log("[AdMob] User finished watching ad. Granting reward.");
      options.onUserEarnedReward({ amount: 1, type: 'bonus' });
      
      this.isShowing = false;
      this.isLoaded = false; // Ad is consumed
      options.onAdClosed?.();
    }, 5000);
  }

  public isAdReady(): boolean {
    return this.isLoaded;
  }
}

export const rewardedAdService = new RewardedAdService();
