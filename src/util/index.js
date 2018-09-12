import { utils, Interface, Wallet } from 'ethers';
import abis from '../../lib/abis/index';
import IssuanceController from '../contracts/IssuanceController';
import Nomin from '../contracts/Nomin';
import Havven from '../contracts/Havven';
const GWEI = 1000000000;
const DEFAULT_GAS_LIMIT = 200000;

class Util {
  /**
   * set of helper functions
   * @param contractSettings
   */
  constructor(contractSettings) {
    this.contractSettings = contractSettings;
    this.issuanceController = new IssuanceController(contractSettings);
    this.nomin = new Nomin(contractSettings);
    this.havven = new Havven(contractSettings);
    this.issuanceControllerInterface = new Interface(abis.IssuanceController);
    this.nominInterface = new Interface(abis.Nomin);

    this.signAndSendTransaction = this.signAndSendTransaction.bind(this);
    this.getEventLogs = this.getEventLogs.bind(this);
    this.getLatestConversions = this.getLatestConversions.bind(this);
    this.getGasAndSpeedInfo = this.getGasAndSpeedInfo.bind(this);
    this.waitForTransaction = this.waitForTransaction.bind(this);
    this.getGasEstimate = this.getGasEstimate.bind(this);
  }

  /**
   * converts number (as a string) to a BigNumber
   * @param value {String}
   * @returns {BigNumber}
   */
  parseEther(value) {
    return utils.parseEther(value);
  }

  /**
   * converts BigNumber to number (as a string)
   * @param value {BigNunber}
   * @returns {String}
   */
  formatEther(value) {
    return utils.formatEther(value);
  }

  /**
   * Manually sign any transaction with custom signer
   * @param transaction
   * @param fromAddress
   * @returns {Promise<void>}
   */
  async signAndSendTransaction({ transaction, fromAddress }) {
    transaction.nonce = await this.contractSettings.provider.getTransactionCount(fromAddress);
    transaction.gasLimit = 200000;
    transaction.chainId = this.contractSettings.networkId;

    const signedTx = await this.contractSettings.signer.sign(transaction);
    const signedSerialziedTx = '0x' + signedTx.serialize().toString('hex');
    return await this.contractSettings.provider.sendTransaction(signedSerialziedTx);
  }

  /**
   * Returns event logs for a specific contract event and fetches block timestamp for each transaction
   * @param contractAddress {String} in format "0x1234567890abcdef"
   * @param event - {Object<ethers.Interface>}ethers.js event interface
   * @param fromBlock
   * @returns {Promise<*>}
   */
  async getEventLogs(contractAddress, event, fromBlock) {
    const blockTimestampMap = {};
    try {
      const logs = await this.contractSettings.provider.getLogs({
        fromBlock: fromBlock,
        address: contractAddress,
        topics: event.topics,
      });
      const events = logs.map(log => ({
        ...log,
        parsedData: event.parse(log.topics, log.data),
      }));
      const blocks = await Promise.all(
        events.map(event => this.contractSettings.provider.getBlock(event.blockNumber))
      );
      blocks.forEach(block => {
        blockTimestampMap[block.number] = new Date(block.timestamp * 1000);
      });
      events.forEach(event => {
        event.timestamp = blockTimestampMap[event.blockNumber];
      });
      return events;
    } catch (err) {
      console.log(err);
    }
  }

  async getLatestConversions() {
    const latestBlockNumber = await this.contractSettings.provider.getBlockNumber();
    const contractAddr = this.contractSettings.addressList.IssuanceController;

    const ExchangeEvent = this.issuanceControllerInterface.events.Exchange;
    let events = await this.getEventLogs(contractAddr, ExchangeEvent, latestBlockNumber - 10000);
    if (events.length < 5) {
      events = await this.getEventLogs(contractAddr, ExchangeEvent, latestBlockNumber - 100000);
    }
    if (!events || !events.length) {
      return [];
    }
    return events.reverse().slice(0, 20);
  }

  formatBigNumber(amount, decimals) {
    if (!amount) return '-';

    const amountString = utils.formatEther(amount, { commify: true });

    if (typeof decimals === 'undefined') {
      return amountString;
    } else {
      const [first, remainder] = amountString.split('.');
      let joined = `${first}.${remainder.substring(0, decimals)}`;

      if (joined.endsWith('.')) return joined.substring(0, joined.length - 1);

      return joined;
    }
  }

  formatNumber(amount, decimal) {
    if (amount === '' || amount === null) {
      return '';
    }
    return parseFloat(amount).toFixed(decimal);
  }

  formatNumberMaxDecimal(amount, decimal) {
    return Math.round(amount * Math.pow(10, decimal)) / Math.pow(10, decimal);
  }

  async getTransactionInformation(transactionHash) {
    if (typeof transactionHash !== 'string') {
      throw new Error('transactionHash must be a string');
    }
    return await this.contractSettings.provider.getTransaction(transactionHash);
  }

  /**
   * Estimates gas for a transaction
   * @param toAddress - where to send transaction
   * @param ethValue - optional - if function requires ETH to be sent
   * @param data - optional if function requires data to be sent
   * example  (new Interface(CONTRACT_ABIS.IssuanceController).functions.exchangeEtherForNomins()).data
   * example2 nominInterface.functions.approve(MAINNET_ADDRESSES.IssuanceController, utils.parseEther("2")).data;
   * @returns {Promise<String>}
   */
  async getGasEstimate(toAddress, ethValue, data) {
    // to get the gas estimate, the contract needs to be
    // initialized with a wallet or a customSigner
    const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123';
    const wallet = new Wallet(privateKey, this.provider);
    const tx = { to: toAddress };
    if (ethValue) {
      tx.value = ethValue;
    }
    if (data) {
      tx.data = data;
    }
    const estimate = await wallet.estimateGas(tx);
    return estimate.toString();
  }

  /**
   * Waits for ethereum transaction to succeed or fail. Checks the status every second.
   * @param transactionHash
   * @returns {Promise<*>}
   */
  async waitForTransaction(transactionHash) {
    return new Promise(resolve => {
      const check = async () => {
        const transactionInformation = await this.getTransactionInformation(transactionHash);
        if (transactionInformation && transactionInformation.blockHash) {
          resolve(true);
        } else {
          setTimeout(check, 1000);
        }
      };
      check();
    });
  }

  /**
   * Returns the object with estimates for slow, average and fast gas prices and approximate waiting times
   * @returns {Promise<{gasFastGwei: number, gasAverageGwei: number, gasSlowGwei: number, timeFastMinutes: *, timeAverageMinutes: *, timeSlowMinutes: *}>}
   */
  async getGasAndSpeedInfo() {
    // ethToNomin uses approx 80,000, nominToHav 40,000 but approve 70,000; 100,000 is safe average
    const convetorTxGasPrice = DEFAULT_GAS_LIMIT;
    let [egsData, ethPrice] = await Promise.all([
      fetch('https://ethgasstation.info/json/ethgasAPI.json'),
      this.getEtherPrice(),
    ]);
    egsData = await egsData.json();
    ethPrice = Number(utils.formatEther(ethPrice));
    const data = {
      gasFastGwei: egsData.fast / 10,
      gasAverageGwei: egsData.average / 10,
      gasSlowGwei: egsData.safeLow / 10,
      timeFastMinutes: egsData.fastWait,
      timeAverageMinutes: egsData.avgWait,
      timeSlowMinutes: egsData.safeLowWait,
    };
    data.priceFastUsd =
      Math.round(((data.gasFastGwei * ethPrice * convetorTxGasPrice) / GWEI) * 1000) / 1000;
    data.priceAverageUsd =
      Math.round(((data.gasAverageGwei * ethPrice * convetorTxGasPrice) / GWEI) * 1000) / 1000;
    data.priceSlowUsd =
      Math.round(((data.gasSlowGwei * ethPrice * convetorTxGasPrice) / GWEI) * 1000) / 1000;
    return data;
  }
}

export default Util;