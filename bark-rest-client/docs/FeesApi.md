# \FeesApi

All URIs are relative to *http://localhost*

Method | HTTP request | Description
------------- | ------------- | -------------
[**ark_send_fee**](FeesApi.md#ark_send_fee) | **POST** /api/v1/fees/ark/send | Estimate the full Ark-send cost without sending
[**board_fee**](FeesApi.md#board_fee) | **GET** /api/v1/fees/board | Estimate board fee
[**lightning_receive_fee**](FeesApi.md#lightning_receive_fee) | **GET** /api/v1/fees/lightning/receive | Estimate Lightning receive fee
[**lightning_send_fee**](FeesApi.md#lightning_send_fee) | **GET** /api/v1/fees/lightning/pay | Estimate Lightning send fee
[**offboard_all_fee**](FeesApi.md#offboard_all_fee) | **GET** /api/v1/fees/offboard-all | Estimate offboard-all fee
[**offboard_fee**](FeesApi.md#offboard_fee) | **POST** /api/v1/fees/offboard | Estimate offboard fee
[**onchain_fee_rates**](FeesApi.md#onchain_fee_rates) | **GET** /api/v1/fees/onchain | Get on-chain fee rates
[**send_onchain_fee**](FeesApi.md#send_onchain_fee) | **GET** /api/v1/fees/send-onchain | Estimate send-onchain fee



## ark_send_fee

> models::ArkSendEstimateResponse ark_send_fee(ark_send_estimate_request)
Estimate the full Ark-send cost without sending

Read-only preview. Does not lock inputs, allocate keys, sign or send. Recovery reserves reduce spendable funds and are not separately refundable deposits. Insufficient funds, dust and refresh requirements return an error, never a zero-cost quote. Send total_debit_sat as max_total_sat to wallet/send to cap the approved debit. Estimates do not reserve funds.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**ark_send_estimate_request** | [**ArkSendEstimateRequest**](ArkSendEstimateRequest.md) |  | [required] |

### Return type

[**models::ArkSendEstimateResponse**](ArkSendEstimateResponse.md)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## board_fee

> models::FeeEstimateResponse board_fee(amount_sat)
Estimate board fee

Estimates the Ark protocol fee for boarding the specified amount of on-chain bitcoin. The net amount is what the user receives as a VTXO. Does not include the on-chain transaction fee for the board anchor transaction.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**amount_sat** | **i64** | The amount in satoshis to board | [required] |

### Return type

[**models::FeeEstimateResponse**](FeeEstimateResponse.md)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## lightning_receive_fee

> models::FeeEstimateResponse lightning_receive_fee(amount_sat)
Estimate Lightning receive fee

Estimates the fee for receiving the specified amount over Lightning. The gross amount is the Lightning payment amount, and the net amount is what the user receives as a VTXO after the Ark server deducts its fee.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**amount_sat** | **i64** | The amount in satoshis to receive over Lightning | [required] |

### Return type

[**models::FeeEstimateResponse**](FeeEstimateResponse.md)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## lightning_send_fee

> models::FeeEstimateResponse lightning_send_fee(amount_sat)
Estimate Lightning send fee

Estimates the fee for sending the specified amount over Lightning. The net amount is what the recipient receives. The fee depends on the VTXOs selected and their expiry, and includes funded recovery reserves. Uses the same transaction-builder validation as payment submission. Returns an error when no usable input combination is found.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**amount_sat** | **i64** | The amount in satoshis to send over Lightning | [required] |

### Return type

[**models::FeeEstimateResponse**](FeeEstimateResponse.md)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## offboard_all_fee

> models::FeeEstimateResponse offboard_all_fee(address)
Estimate offboard-all fee

Estimates the fee for offboarding the entire Ark balance to the given on-chain address. The gross amount is the total spendable balance, and the net amount is what the user receives on-chain after fees. The fee depends on the destination address type, current fee rates, and VTXO expiry.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**address** | **String** | The destination Bitcoin address | [required] |

### Return type

[**models::FeeEstimateResponse**](FeeEstimateResponse.md)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## offboard_fee

> models::FeeEstimateResponse offboard_fee(offboard_fee_estimate_request)
Estimate offboard fee

Estimates the fee for offboarding a specific set of VTXOs to the given on-chain address. Each VTXO is offboarded in full. The gross amount is the total value of the selected VTXOs, and the net amount is what the user receives on-chain after fees. The fee depends on the destination address type, current fee rates, and VTXO expiry.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**offboard_fee_estimate_request** | [**OffboardFeeEstimateRequest**](OffboardFeeEstimateRequest.md) |  | [required] |

### Return type

[**models::FeeEstimateResponse**](FeeEstimateResponse.md)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## onchain_fee_rates

> models::OnchainFeeRatesResponse onchain_fee_rates()
Get on-chain fee rates

Returns the current mempool fee rates from the chain source at three confirmation targets: fast (~1 block), regular (~3 blocks), and slow (~6 blocks). Rates are in sat/vB, rounded up.

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::OnchainFeeRatesResponse**](OnchainFeeRatesResponse.md)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## send_onchain_fee

> models::FeeEstimateResponse send_onchain_fee(amount_sat, address)
Estimate send-onchain fee

Estimates the total fee for sending bitcoin from the Ark wallet to an on-chain address. The fee depends on the destination address type and current fee rates. The gross amount is what the user pays (including VTXOs spent), and the net amount is what the recipient receives on-chain.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**amount_sat** | **i64** | The amount in satoshis to send on-chain | [required] |
**address** | **String** | The destination Bitcoin address | [required] |

### Return type

[**models::FeeEstimateResponse**](FeeEstimateResponse.md)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)
