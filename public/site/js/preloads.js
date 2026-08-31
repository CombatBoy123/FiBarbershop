
    (function() {
      var preconnectOrigins = ["https://cdn.shopify.com"];
      var scripts = ["/cdn/shopifycloud/checkout-web/assets/c1/polyfills.Db3KX98s.js","/cdn/shopifycloud/checkout-web/assets/c1/app.BVNLOgcv.js","/cdn/shopifycloud/checkout-web/assets/c1/esnext-vendor.CmW6xMpC.js","/cdn/shopifycloud/checkout-web/assets/c1/context-browser.CN6-PAKC.js","/cdn/shopifycloud/checkout-web/assets/c1/checkout-policy.CWu-Li9u.js","/cdn/shopifycloud/checkout-web/assets/c1/proposal-delegated-payment-instrument.C3RXhb5U.js","/cdn/shopifycloud/checkout-web/assets/c1/helpers-setAddressErrors.C3phlMlZ.js","/cdn/shopifycloud/checkout-web/assets/c1/shop-pay-normalizeBuyerDetails.BgGdw31m.js","/cdn/shopifycloud/checkout-web/assets/c1/addresses-is-address-empty.BU1oYvSb.js","/cdn/shopifycloud/checkout-web/assets/c1/receipt-mapper-load-recovery.Dsc5K8d_.js","/cdn/shopifycloud/checkout-web/assets/c1/receipt-eager-mappers.CltkxFMm.js","/cdn/shopifycloud/checkout-web/assets/c1/sections-shared.DBvYaY5e.js","/cdn/shopifycloud/checkout-web/assets/c1/consent-manager-shared.CFnl1rQV.js","/cdn/shopifycloud/checkout-web/assets/c1/error-logger-report-graphql-error.Cykb4j7q.js","/cdn/shopifycloud/checkout-web/assets/c1/utilities-shopCashMoney.XaO5lrcX.js","/cdn/shopifycloud/checkout-web/assets/c1/graphql-PaymentSessionMutation.DAAiek8L.js","/cdn/shopifycloud/checkout-web/assets/c1/amazon-pay-useAmazonPayPaymentLine.B5hbHIgl.js","/cdn/shopifycloud/checkout-web/assets/c1/hydrate.CuYXRUxQ.js","/cdn/shopifycloud/checkout-web/assets/c1/shop-pay-installments-monorail.Droj1aPk.js","/cdn/shopifycloud/checkout-web/assets/c1/locale-en.BnibTEC-.js","/cdn/shopifycloud/checkout-web/assets/c1/OnePage._h0V0Lf9.js","/cdn/shopifycloud/checkout-web/assets/c1/components-DeliveryTransition.EozufpMU.js","/cdn/shopifycloud/checkout-web/assets/c1/useShopPayButtonClassName.B255RaZm.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useUnauthenticatedErrorModal.BpuQ_2zI.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useShopPayNewSignupLoginExperiment.D5OuH0_B.js","/cdn/shopifycloud/checkout-web/assets/c1/crypto-constants.B1Oek1cx.js","/cdn/shopifycloud/checkout-web/assets/c1/ChangeCompanyLocationLink.DoAU_QYv.js","/cdn/shopifycloud/checkout-web/assets/c1/BillingAddressForm.Cc5lj_Hz.js","/cdn/shopifycloud/checkout-web/assets/c1/PhoneField.BjWug5Ff.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useSuppressShopPayModalOnLoad.5fJaQqt_.js","/cdn/shopifycloud/checkout-web/assets/c1/components-RedirectionNotice.module.BSEF3st7.js","/cdn/shopifycloud/checkout-web/assets/c1/Popover.D717-xJ-.js","/cdn/shopifycloud/checkout-web/assets/c1/Choice.CeJ1cP3D.js","/cdn/shopifycloud/checkout-web/assets/c1/Checkbox.j2fv9b2B.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useForceShopPayUrl.cBmUeERc.js","/cdn/shopifycloud/checkout-web/assets/c1/shipping-methods-grouping.Dj8uCstx.js","/cdn/shopifycloud/checkout-web/assets/c1/ShopPayLogo.BkYn8QOX.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useWalletsTimeout.DAkY6Nky.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-usePostPurchase.Cfi7J6OC.js","/cdn/shopifycloud/checkout-web/assets/c1/utilities-stopwatch.CaaTW6B9.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useWalletsMonorailTrack.7H0MN5Z1.js","/cdn/shopifycloud/checkout-web/assets/c1/IncentiveBadge.G4cNy5uU.js","/cdn/shopifycloud/checkout-web/assets/c1/cross-border-hooks.CFZIRFSP.js","/cdn/shopifycloud/checkout-web/assets/c1/AutocompleteField-hooks.ByPN4isa.js","/cdn/shopifycloud/checkout-web/assets/c1/PendingShipping.CirDV-2J.js","/cdn/shopifycloud/checkout-web/assets/c1/useAddressMutationsWithNegotiation.BfN93tvT.js","/cdn/shopifycloud/checkout-web/assets/c1/PaymentIcon.IVPvfpvD.js","/cdn/shopifycloud/checkout-web/assets/c1/PaymentLine.CtusvIKr.js","/cdn/shopifycloud/checkout-web/assets/c1/Theme-ThemeOverride.DwiNVOJh.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useUpdateCheckoutAddress.jsXGu-Mw.js","/cdn/shopifycloud/checkout-web/assets/c1/payment-usePaymentExemptionReason.DfwldTnL.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useShopPayProgressIntercepts.D8FkeRAU.js","/cdn/shopifycloud/checkout-web/assets/c1/Section.BmeDGTIQ.js","/cdn/shopifycloud/checkout-web/assets/c1/Section-SectionStyleOverride.Bzv1vO2W.js","/cdn/shopifycloud/checkout-web/assets/c1/PaymentErrorBanner.DXPIjIFz.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useGeneralPaymentErrorMessage.BTPvKHs7.js","/cdn/shopifycloud/checkout-web/assets/c1/StickyPayButton-StickyPayButton.module.q9yAF0vD.js","/cdn/shopifycloud/checkout-web/assets/c1/PayButton-helpers.CDOYiXYf.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-payment-button.DWwZknOY.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-usePreselectSpi.CVjSSZNE.js","/cdn/shopifycloud/checkout-web/assets/c1/Switch.BzjLp9v7.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useAvailableShopPromotionDiscounts.BOrJVMtq.js","/cdn/shopifycloud/checkout-web/assets/c1/checkout-as-guest-amazon-pay.DMDiuqUY.js","/cdn/shopifycloud/checkout-web/assets/c1/Middot.pr3b3ReE.js","/cdn/shopifycloud/checkout-web/assets/c1/EstimatedDeliveryContent.BbImoMkw.js","/cdn/shopifycloud/checkout-web/assets/c1/ShippingMethodRateLabel.C26r7dp3.js","/cdn/shopifycloud/checkout-web/assets/c1/shipping-methods-consolidated-included.CvWtyMbA.js","/cdn/shopifycloud/checkout-web/assets/c1/ShippingLines.DntUQmED.js","/cdn/shopifycloud/checkout-web/assets/c1/ShipmentBreakdown.Dlv63Ikf.js","/cdn/shopifycloud/checkout-web/assets/c1/MerchandiseModal.BA9rJU7j.js","/cdn/shopifycloud/checkout-web/assets/c1/ShippingMethodSelector.CUL1gDy5.js","/cdn/shopifycloud/checkout-web/assets/c1/TextArea.CSCU_am9.js","/cdn/shopifycloud/checkout-web/assets/c1/SubscriptionPriceBreakdown.c_6F6Vl4.js","/cdn/shopifycloud/checkout-web/assets/c1/StockProblems-StockProblemsLineItemList.DpazS599.js"];
      var styles = ["/cdn/shopifycloud/checkout-web/assets/c1/assets/app.C61fwjfC.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/checkout-policy.D3dsGF4R.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/useAmazonPayPaymentLine.CFqkT8xi.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/previous.C3xTuzvt.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/OnePage.CNHfYFLR.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/DeliveryTransition.CxmS455s.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/useAddressMutationsWithNegotiation.DPEapfiO.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/Section.CU18S7Ap.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/PaymentLine.0ZuT82rY.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/StickyPayButton.3WRao8Y9.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/PaymentIcon.CLVwzp6i.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/useShopPayProgressIntercepts.CIy8uDiZ.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/Choice.CP8QNAbt.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/IncentiveBadge.Dlnp55te.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/BillingAddressForm.BdwN7V1K.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/Switch.Dq_6Ius6.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/useShopPayButtonClassName.CpHF4L7Q.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/PhoneField.uZEuHncj.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/Middot.D7Ujmshx.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/ShippingLines.LcqrKXE1.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/MerchandiseModal.D6OuIVjc.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/EstimatedDeliveryContent.B_THySFF.css","/cdn/shopifycloud/checkout-web/assets/c1/assets/RedirectionNotice.B8v_QGNW.css"];
      var fontPreconnectUrls = [];
      var fontPrefetchUrls = [];
      var imgPrefetchUrls = ["https://cdn.shopify.com/s/files/1/0916/0399/2903/files/2AE4A3DF-EE8D-4A2E-B53B-F875DCDBFFA9_x320.png?v=1767020882","https://cdn.shopify.com/s/files/1/0916/0399/2903/files/ChatGPT_Image_1._jaan_2026_16_39_24_5aa65549-1912-4cd3-a73f-648d2608a365_2000x.png?v=1767278410"];

      function preconnect(url, callback) {
        var link = document.createElement('link');
        link.rel = 'dns-prefetch preconnect';
        link.href = url;
        link.crossOrigin = '';
        link.onload = link.onerror = callback;
        document.head.appendChild(link);
      }

      function preconnectAssets() {
        var resources = preconnectOrigins.concat(fontPreconnectUrls);
        var index = 0;
        (function next() {
          var res = resources[index++];
          if (res) preconnect(res, next);
        })();
      }

      function prefetch(url, as, callback) {
        var link = document.createElement('link');
        if (link.relList.supports('prefetch')) {
          link.rel = 'prefetch';
          link.fetchPriority = 'low';
          link.as = as;
          if (as === 'font') link.type = 'font/woff2';
          link.href = url;
          link.crossOrigin = '';
          link.onload = link.onerror = callback;
          document.head.appendChild(link);
        } else {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.onloadend = callback;
          xhr.send();
        }
      }

      function prefetchAssets() {
        var resources = [].concat(
          scripts.map(function(url) { return [url, 'script']; }),
          styles.map(function(url) { return [url, 'style']; }),
          fontPrefetchUrls.map(function(url) { return [url, 'font']; }),
          imgPrefetchUrls.map(function(url) { return [url, 'image']; })
        );
        var index = 0;
        function run() {
          var res = resources[index++];
          if (res) prefetch(res[0], res[1], next);
        }
        var next = (self.requestIdleCallback || setTimeout).bind(self, run);
        next();
      }

      function onLoaded() {
        try {
          if (parseFloat(navigator.connection.effectiveType) > 2 && !navigator.connection.saveData) {
            preconnectAssets();
            prefetchAssets();
          }
        } catch (e) {}
      }

      if (document.readyState === 'complete') {
        onLoaded();
      } else {
        addEventListener('load', onLoaded);
      }
    })();
  