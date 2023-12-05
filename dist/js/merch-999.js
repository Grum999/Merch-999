/*
 -----------------------------------------------------------------------------
 Merch-999
 Copyright (C) 2023 - Grum999
 -----------------------------------------------------------------------------
 SPDX-License-Identifier: GPL-3.0-or-later

 https://spdx.org/licenses/GPL-3.0-or-later.html
 -----------------------------------------------------------------------------
 A small web app that let small bands to manage their merch transaction easily
 during concerts
 -----------------------------------------------------------------------------
 
 JS Core
*/

// define constants in a freeze object, easy to exports
let constants = Object.freeze({
    PAYMODE_CASH:   'cash',
    PAYMODE_CC:     'cc',
    
    MERCH_DB_REF: 'merch.db',
    SETUP_STOCK_LOW_LIMIT_ALERT: 'merch999.setup.stock.lowLimitAlert',
    SETUP_EXPORT_FILE_NAME: 'merch999.setup.export.fileName'
});

// some global (erk) variables
let SETUP_STOCK_LOW_LIMIT_ALERT = 4,
    SETUP_EXPORT_FILE_NAME = 'merch',
    UPDATE_BASKET_PAGE = false;

/**
 * Return string `value` with leading zero to reach given `size`
 **/ 
function lead0(value, size) {
    let returned = `${value}`;
    while(returned.length < size) {
        returned = '0' + returned;
    }
    return returned;
}


/** 
 * Class to manage database 
 * - read IndexedDB
 * - write IndexedDB
 * 
 * Events: 'ready'
 *          triggered when database connection is opened and ready to be used 
 */
class DbMngt {

    constructor() {
        this.db = undefined;
        this.listeners = {'ready': []};

        this.requestDb = indexedDB.open(constants.MERCH_DB_REF, 1);
        this.requestDb.addEventListener("upgradeneeded", (event) => this.dbRequestUpgradeNeeded(event.target.result));
        this.requestDb.addEventListener("error", (event) => this.dbRequestError(event.target.errorCode));
        this.requestDb.addEventListener("success", (event) => this.dbRequestSuccess(event.target.result));
    }

    /**
     * Add given `callback` to execute when `eventId` is triggered
     * */
    addEventListener(eventId, callback) {
        if(this.listeners[eventId]!=undefined) {
            this.listeners[eventId].push(callback);
        }
    }

    /**
     * Execute all callback for given `eventId`
     * */
    triggerEvent(eventId) {
        if(this.listeners[eventId]!=undefined) {
            for(const callback of this.listeners[eventId]) {
                callback();
            }
        }
    }

    /**
     * Upgrade database schema if needed
     */
    dbRequestUpgradeNeeded(db) {
        // create the Stock
        //  *ref            unique ref Id for stock item
        //
        //   label          label for stock item
        //   order          sort order for stock item (stock items sorted by type, group, order)
        //   priceCash      price (cash)
        //   priceCC        price (CC)
        //   initialQty     initial quantity in stock for item
        //   currentQty     current quantity in stock for item
        //   type           item type
        //   typeIcon       icon for type
        //   group          item group (label)
        //   icon           SVG icon
        //   bgcolor        background color
        //   fgcolor        foreground color
        //
        // with "ref" as unique id for stock item
        let storageStock = db.createObjectStore('Stock', {
            keyPath: "ref"
        });

        // create the Sales object store
        //  *autoIncrement
        //
        //   ref            unique ref Id for stock item
        //   quantity       quantity taht has been sell
        //   paymentMode    mode used for payment
        //   amount         total paid amount
        //   cashIn         cash amount in
        //   cashOut        cash amount in
        //   timestamp      timestamp for sale
        //   isGift         is item is a gift?
        //
        // with auto-increment id
        let storageSales = db.createObjectStore('Sales', {
            autoIncrement: true
        });

        // Sales is indexed on 'ref'
        storageSales.createIndex('ref', 'ref', {
            unique: false
        });
    }

    /**
     * An error occured on database initialisation
     * Log error in console
     */
    dbRequestError(errorCode) {
        console.error(`Database error: ${errorCode}`);
    }

    /**
     * Database opened an updated
     * Trigger event 'ready'
     */
    dbRequestSuccess(db) {
        this.db = db;
        this.triggerEvent('ready');
    }

    /**
     * Insert a new item in Stock, update Stock
     */
    insertStockItem(itemStock) {
        let returned = new Promise((SUCCESS, ERROR) => {
            itemStock.currentQty = itemStock.initialQty;

            const transaction = this.db.transaction('Stock', 'readwrite');
            const storageStock = transaction.objectStore('Stock');
            let query = storageStock.add(itemStock);

            // handle the error case
            query.addEventListener('error', (event) => {
                console.error("insertStockItem", event.target.error.message);
                return ERROR(event.target.error);
            });

            transaction.addEventListener('complete', (event) => {
                return SUCCESS(itemStock);
            });
        });

        return returned;
    }

    /**
     * Insert a new sale, decrease Stock
     */
    insertSalesItem(itemSales) {
        let returned = new Promise((SUCCESS, ERROR) => {
            const transaction = this.db.transaction('Sales', 'readwrite');
            const storageSales = transaction.objectStore('Sales');

            if(itemSales.timestamp==undefined) {
                itemSales.timestamp = new Date();
            }

            let query = storageSales.put(itemSales);

            // handle the error case
            query.addEventListener('error', (event) => {
                console.error("insertSalesItem", event.target.error.message);
                return ERROR(event.target.error);
            });

            // close the database once the transaction completes
            transaction.addEventListener('complete', (event) => {
                // update live stock once transaction is complete
                for(const saleDetail of itemSales.details) {
                    let result = this.updateStock(saleDetail.ref, 1);
                }
                return SUCCESS(itemSales);
            });
        });

        return returned;
    }

    /**
     * Remove Sale item referenced by key
     */
    removeSalesItem(itemSalesKey) {
        let returned = new Promise((SUCCESS, ERROR) => {
            const transaction = this.db.transaction('Sales', 'readwrite');
            const storageSales = transaction.objectStore('Sales');
            let query = storageSales.get(itemSalesKey);

            // handle the error case
            query.addEventListener('error', (event) => {
                console.error("removeSalesItem", event.target.error.message);
                return ERROR(event.target.error);
            });

            // close the database once the transaction completes
            query.addEventListener('success', (event) => {
                // update live stock once transaction is complete
                let saleData = event.target.result;

                for(const detail of saleData.details) {
                    let result = this.updateStock(detail.ref, -1);
                }
                let query = storageSales.delete(itemSalesKey);
                query.addEventListener('success', (event) => {
                    return SUCCESS(saleData);
                });
            });
        });

        return returned;
    }

    /**
     * Update current Stock for item
     * add given quantity to live stock designed by refItem
     */
    updateStock(refItem, quantity) {
        let returned = new Promise((SUCCESS, ERROR) => {
            const transaction = this.db.transaction('Stock', 'readwrite');
            const storageStock = transaction.objectStore('Stock');

            let query = storageStock.get(refItem);
            // handle the error case
            query.addEventListener('error', (event) => {
                console.error("updateStock", event.target.error.message);
                return ERROR(event.target.error);
            });

            query.addEventListener('success', (event) => {
                let data = event.target.result;
                data.currentQty = data.currentQty - quantity;
                storageStock.put(data);
                return SUCCESS(data);
            });
        });

        return returned;
    }

    /**
     * reset Stock content (delete everything - no sales update!!)
     */
    resetStock() {
        let returned = new Promise((SUCCESS, ERROR) => {
            const transaction = this.db.transaction('Stock', 'readwrite');
            const storageStock = transaction.objectStore('Stock');

            let query = storageStock.clear();

            query.addEventListener('error', (event) => {
                console.error("resetStock", event.target.error.message);
                return ERROR(event.target.error);
            });

            transaction.addEventListener('complete', (event) => {
                return SUCCESS();
            });
        });

        return returned;
    }

    /**
     * reset Sales content (delete everything - no stock update!!)
     */
    resetSales() {
        let returned = new Promise((SUCCESS, ERROR) => {
            const transaction = this.db.transaction('Sales', 'readwrite');
            const storageSales = transaction.objectStore('Sales');

            let query = storageSales.clear();

            query.addEventListener('error', (event) => {
                console.error("resetSales", event.target.error.message);
                return ERROR(event.target.error);
            });

            transaction.addEventListener('complete', (event) => {
                return SUCCESS();
            });
        });

        return returned;
    }

    /**
     * return stock (array of stock item)
     */
    getStock() {
        let returned = new Promise((SUCCESS, ERROR) => {
            const transaction = this.db.transaction('Stock', 'readwrite');
            const storageStock = transaction.objectStore('Stock');
            const sales = storageStock.getAll();

            sales.addEventListener('error', (event) => {
                console.error("getStock", event.target.error.message);
                return ERROR(undefined);
            });

            sales.addEventListener('success', (event) => {
                return SUCCESS(event.target.result);
            });
        });

        return returned;
    }

    /**
     * return sale for given key `itemSalesKey`
     */
    getSale(itemSalesKey) {
        let returned = new Promise((SUCCESS, ERROR) => {
            const transaction = this.db.transaction('Sales', 'readwrite');
            const storageSales = transaction.objectStore('Sales');
            let query = storageSales.get(itemSalesKey);

            // handle the error case
            query.addEventListener('error', (event) => {
                console.error("getSale", event.target.error.message);
                return ERROR(event.target.error);
            });

            query.addEventListener('success', (event) => {
                SUCCESS(event.target.result);
            });

        });

        return returned;
    }

    /**
     * return all sales (array of sale)
     */
    getSales() {
        let returned = new Promise((SUCCESS, ERROR) => {
            const transaction = this.db.transaction('Sales', 'readwrite');
            const storageSales = transaction.objectStore('Sales');
            const salesCursor = storageSales.openCursor();
            let returnedSales = [];

            salesCursor.addEventListener('error', (event) => {
                console.error("getSales", event.target.error.message);
                return ERROR(undefined);
            });

            salesCursor.addEventListener('success', (event) => {
                let cursor = event.target.result;
                if (cursor) {
                    let key = cursor.primaryKey;
                    let value = cursor.value;
                    value.key = key;
                    returnedSales.push(value);
                    cursor.continue();
                }
                else {
                    return SUCCESS(returnedSales);
                }
            });

        });

        return returned;
    }

    /**
     * Load a stock file
     */
    loadStockFromFile(file) {
        let returned = new Promise((SUCCESS, ERROR) => {
            let fileReader = new FileReader();
            fileReader.addEventListener('load', (event) => {
                const re = /^\s*(#.*|;+)?$/;
                const fileLines = fileReader.result.split('\n');

                this.resetStock();
                this.resetSales();

                for(let fileLine of fileLines) {
                    // remove windows '\r' character
                    fileLine = fileLine.replaceAll('\r', '');

                    if(re.test(fileLine)) {
                        // comment or empty line
                        continue;
                    }
                    let fields = fileLine.split(';');
                    let record = {ref:          fields[0],
                                  label:        fields[1],
                                  order:        parseInt(fields[2]),
                                  priceCash:    parseFloat(fields[3]),
                                  priceCC:      parseFloat(fields[4]),
                                  initialQty:   parseInt(fields[5]),
                                  currentQty:   parseInt(fields[5]),
                                  type:         fields[6],
                                  typeIcon:     fields[7],
                                  group:        fields[8],
                                  icon:         fields[9],
                                  bgcolor:      fields[10],
                                  fgcolor:      fields[11]
                                 };

                    this.insertStockItem(record);
                }
                SUCCESS();
            });
            fileReader.readAsText(file);
        });
        return returned;
    }

    /**
     * Save stock/sales file
     */
    saveStockAndSalesFile() {
        const workbook = new ExcelJS.Workbook();

        this.getSales().then(saleItems => {
            let saleInitialCash = document.getElementById('saleInitialCash').value,
                exportedRowsSales = [],
                exportedRowsSalesDetails = [],
                exportedRowsStock = [];

            if(saleInitialCash=='') {
                saleInitialCash = 0;
            }
            else {
                saleInitialCash = parseFloat(saleInitialCash);
            }

            // stock has been retrieved, do sort
            saleItems.sort((a, b) => {
                // sort by date
                if(a.timestamp > b.timestamp) {
                    return 1;
                }
                else if(a.timestamp < b.timestamp) {
                    return -1;
                }
                else {
                    return 0;
                }
            });

            // build table content
            for(const saleItem of saleItems) {
                let tableRowSales = [],
                    paymentMode = '';

                // date
                tableRowSales.push(saleItem.timestamp);

                // payment mode
                if(saleItem.paymentMode==constants.PAYMODE_CASH) {
                    paymentMode = 'Cash';
                }
                else {
                    paymentMode = 'Credit Card';
                }
                tableRowSales.push(paymentMode);

                // amount
                tableRowSales.push(saleItem.amount);

                // cash in
                if(saleItem.paymentMode==constants.PAYMODE_CASH) {
                    tableRowSales.push(saleItem.cashIn);
                }
                else {
                    tableRowSales.push('');
                }

                // cash out
                if(saleItem.paymentMode==constants.PAYMODE_CASH) {
                    tableRowSales.push(saleItem.cashOut);
                }
                else {
                    tableRowSales.push('');
                }

                exportedRowsSales.push(tableRowSales);
                
                for(const detail of saleItem.details) {
                    let tableRowSalesDetails = [detail.ref, detail.label, saleItem.timestamp, paymentMode, detail.amount];
                    if(detail.isGift) {
                        tableRowSalesDetails.push('YES');
                    }
                    exportedRowsSalesDetails.push(tableRowSalesDetails);
                }
            }

            const worksheetSales = workbook.addWorksheet("Sales", { views: [{state: 'frozen', ySplit:1}]});
            worksheetSales.columns = [
                    { header: 'Date', 
                      key: 'date', 
                      width: 22, 
                      style: { numFmt: 'yyyy-mm-dd hh:mm:ss',
                               alignment: { horizontal: 'left' },
                               font: { name: 'sans' } 
                             } 
                    },
                    { header: 'Payment mode', 
                      key: 'paymode', 
                      width: 20
                    },
                    { header: 'Amount', 
                      key: 'amount', 
                      width: 12, 
                      style: { numFmt: '0.00',
                               alignment: { horizontal: 'right' },
                               font: { name: 'sans' } 
                             }, 
                    },
                    { header: 'Cash In', 
                      key: 'cashin', 
                      width: 12, 
                      style: { numFmt: '0.00',
                               alignment: { horizontal: 'right' } ,
                               font: { name: 'sans' }
                             }, 
                    },
                    { header: 'Cash Out',
                      key: 'cashout', 
                      width: 12,
                      style: { numFmt: '0.00',
                               alignment: { horizontal: 'right' },
                               font: { name: 'sans' }
                             }, 
                    }
                ];
            worksheetSales.getRow(1).font = { bold: true,
                                              name: 'sans'
                                            };
            worksheetSales.getRow(1).alignment = { horizontal: 'left' };
            worksheetSales.autoFilter = 'A1:E1';
            worksheetSales.addRows(exportedRowsSales);

            const worksheetSalesDetails = workbook.addWorksheet("Sales details", { views: [{state: 'frozen', ySplit:1}]});
            worksheetSalesDetails.columns = [
                    { header: 'Ref',
                      key: 'ref',
                      width: 25,
                      style: { font: { name: 'sans' } } 
                    },
                    { header: 'Label',
                      key: 'label',
                      width: 35,
                      style: { font: { name: 'sans' } } 
                    },
                    { header: 'Date', 
                      key: 'date', 
                      width: 22, 
                      style: { numFmt: 'yyyy-mm-dd hh:mm:ss',
                               alignment: { horizontal: 'left' },
                               font: { name: 'sans' } 
                             } 
                    },
                    { header: 'Payment mode', 
                      key: 'paymode', 
                      width: 20,
                      style: { font: { name: 'sans' } } 
                    },
                    { header: 'Amount', 
                      key: 'amount', 
                      width: 12, 
                      style: { numFmt: '0.00',
                               alignment: { horizontal: 'right' },
                               font: { name: 'sans' } 
                             }, 
                    },
                    { header: 'Gift', 
                      key: 'gift', 
                      width: 12, 
                      style: { font: { name: 'sans' } 
                             }, 
                    },
                ];
            worksheetSalesDetails.getRow(1).font = { bold: true,
                                                     name: 'sans'
                                                   };
            worksheetSalesDetails.getRow(1).alignment = { horizontal: 'left' };
            worksheetSalesDetails.autoFilter = 'A1:E1';
            worksheetSalesDetails.addRows(exportedRowsSalesDetails);
            
            this.getStock().then(stockItems => {
                // stock has been retrieved, do sort
                stockItems.sort((a, b) => {
                    // sort by type, group, order
                    if(a.type > b.type) {
                        return 1;
                    }
                    else if(a.type < b.type) {
                        return -1;
                    }
                    else {
                        if(a.group > b.group) {
                            return 1;
                        }
                        else if(a.group < b.group) {
                            return -1;
                        }
                        else {
                            if(a.order > b.order) {
                                return 1;
                            }
                            else if(a.order < b.order) {
                                return -1;
                            }
                            else {
                                return 0;
                            }
                        }
                    }
                });

                // build table content
                for(const stockItem of stockItems) {
                    let tableRowStock = [stockItem.ref, stockItem.label, stockItem.initialQty, stockItem.currentQty, stockItem.initialQty - stockItem.currentQty];
                    exportedRowsStock.push(tableRowStock);
                }

                const worksheetStock = workbook.addWorksheet("Stock", { views: [{state: 'frozen', ySplit:1}]});
                worksheetStock.columns = [
                        { header: 'Ref',
                          key: 'ref',
                          width: 25,
                          style: { font: { name: 'sans' } } 
                        },
                        { header: 'Label',
                          key: 'label',
                          width: 35,
                          style: { font: { name: 'sans' } } 
                        },
                        { header: 'Initial', 
                          key: 'stockinit', 
                          width: 12, 
                          style: { numFmt: '0',
                                   alignment: { horizontal: 'right' },
                                   font: { name: 'sans' } 
                                 } 
                        },
                        { header: 'Current', 
                          key: 'stockcurrent', 
                          width: 20,
                          style: { numFmt: '0',
                                   alignment: { horizontal: 'right' },
                                   font: { name: 'sans' } 
                                 } 
                        },
                        { header: 'Sold', 
                          key: 'sold', 
                          width: 12, 
                          style: { numFmt: '0',
                                   alignment: { horizontal: 'right' },
                                   font: { name: 'sans' } 
                                 } 
                        }
                    ];
                worksheetStock.getRow(1).font = { bold: true,
                                                        name: 'sans'
                                                    };
                worksheetStock.getRow(1).alignment = { horizontal: 'left' };
                worksheetStock.autoFilter = 'A1:E1';
                worksheetStock.addRows(exportedRowsStock);                
                
                workbook.xlsx.writeBuffer().then(buffer => { 
                    let blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
                    let link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = SETUP_EXPORT_FILE_NAME;
                    link.click();
                    URL.revokeObjectURL(link.href);                 
                });                
            });
        });
    }
}


/**
 * main navigation bar + link to pages
 */
class NavBar {
    
    constructor(id) {
        // get navigation bart DOM element
        this.domNav = document.getElementById(id);
        this.activePage = undefined;
        this.activeMenu = undefined;
        this.callbackPages = {};

        if(this.domNav) {
            // get pages linked to navigation bar
            let pages = this.domNav.querySelectorAll('a[data-page]');

            for(const page of pages) {
                // get linked page to navigation bar button
                let linkedPageId = page.attributes['data-page'].value,
                    linkedPage = document.getElementById(linkedPageId);

                if(linkedPage) {
                    this.callbackPages[linkedPageId] = undefined;

                    if(linkedPage.classList.contains('merch-page-active')) {
                        this.activePage = linkedPage;
                        this.activeMenu = page;
                        this.activeMenu.classList.add('merch-page-active');
                    }
                }

                page.addEventListener('click', (event) => {
                    let activePageId = event.target.attributes['data-page'].value,
                        linkedPage = document.getElementById(activePageId);

                    if(this.callbackPages[activePageId]) {
                        // a callback has been set for page, execute it before activating page
                        this.callbackPages[activePageId]();
                    }

                    this.activePage.classList.toggle('merch-page-active');
                    this.activePage.classList.toggle('merch-page-notactive');
                    this.activePage = linkedPage;
                    this.activePage.classList.toggle('merch-page-active');
                    this.activePage.classList.toggle('merch-page-notactive');
                    
                    
                    this.activeMenu.classList.toggle('merch-page-active');
                    this.activeMenu.classList.toggle('merch-page-notactive');
                    this.activeMenu = event.target;
                    this.activeMenu.classList.toggle('merch-page-active');
                    this.activeMenu.classList.toggle('merch-page-notactive');
                });
            }
        }
    }

    /**
     * Set callback to execute when a page is activated
     */
    setCallbackPage(pageId, callback) {
        this.callbackPages[pageId] = callback;
    }
}


/**
 * manage pages contents
 */
class Pages {
    constructor(dbMngt) {
        this.dbMngt = dbMngt;
        this.basketBuilt = false;
        this.basketPageId = undefined;

        this.basketEntryId = 0;
        this.basketAmountCash = 0.00;
        this.basketAmountCc = 0.00;
        this.basketAmountCashIn = 0.00;
        this.basketAmountCashOut = 0.00;
        this.basketPaymentMode = constants.PAYMODE_CC;
        this.basketItems = [];
    }

    /**
     * Build stock page
     *
     * Create a table
     * - Items in stock are sorted by: type, group, order
     *
     * +--------------------------------------+---------------+---------------+---------------------------+
     * | Item                                 | Initial stock | Current stock | Sold                      |
     * +--------------------------------------+---------------+---------------+---------------------------+
     * | (icon type)(icon item) label         | initialQty    | currentQty    | (initialQty - currentQty) |
     * +--------------------------------------+---------------+---------------+---------------------------+
     *
     */
    buildStock() {
        let tableRows = [];
        let stockList = document.getElementById('stockList');

        this.dbMngt.getStock().then(stockItems => {
            // stock has been retrieved, do sort
            stockItems.sort((a, b) => {
                // sort by type, group, order
                if(a.type > b.type) {
                    return 1;
                }
                else if(a.type < b.type) {
                    return -1;
                }
                else {
                    if(a.group > b.group) {
                        return 1;
                    }
                    else if(a.group < b.group) {
                        return -1;
                    }
                    else {
                        if(a.order > b.order) {
                            return 1;
                        }
                        else if(a.order < b.order) {
                            return -1;
                        }
                        else {
                            return 0;
                        }
                    }
                }
            });

            // build table content
            for(const stockItem of stockItems) {
                let classAlert='';

                if(stockItem.currentQty == 0) {
                    classAlert=" merch-is-empty";
                }
                else if(stockItem.currentQty <= SETUP_STOCK_LOW_LIMIT_ALERT) {
                    classAlert=" merch-is-low";
                }

                tableRows.push('<tr>');
                tableRows.push('<td>');
                if(/\.svg$/.test(stockItem.icon)) {
                    tableRows.push(`<span class="merch-item" style="background-image: url('./svg/${stockItem.icon}'); background-color: ${stockItem.bgcolor}; color: ${stockItem.fgcolor};">&nbsp;</span>`);
                }
                else {
                    tableRows.push(`<span class="merch-item fa ${stockItem.icon}" style="background-color: ${stockItem.bgcolor}; color: ${stockItem.fgcolor};">&nbsp;</span>`);
                }
                tableRows.push(`<span>${stockItem.label}</span>`);
                tableRows.push('</td>');
                tableRows.push(`<td class="text-right">${stockItem.initialQty}</td>`)
                tableRows.push(`<td class="text-right${classAlert}">${stockItem.currentQty}</td>`)
                tableRows.push(`<td class="text-right">${stockItem.initialQty - stockItem.currentQty}</td>`)
                tableRows.push('</tr>');
            }

            // set table content
            stockList.innerHTML = tableRows.join('');
        });
    }

    /**
     * Build sales page
     * 
     * 1) head synthesis 
     * +------------------------------------------------+--------------------------------------------------------+
     * | Initial cash                                   |                                      (saleInitialCash) |
     * | Current cash                                   |                                      (saleCurrentCash) |
     * |  Total Sales (saleCountTotalCash) - Cash       | (saleTotalCashIn)  (saleTotalCashOut)  (saleTotalCash) |
     * |  Total Sales (saleCountTotalCC) - Credit Card  |                                          (saleTotalCC) |
     * |  Total Sales (saleCountTotal)                  |                                            (saleTotal) |
     * +------------------------------------------------+--------------------------------------------------------+
     * 
     * 2) details 
     * +--------------------------------------+-----------------+------------------------------------------------+
     * | Date                                 | Amount          |                      Cash                      |
     * |                                      |                 | Cash in        | Cash out        | Total       | 
     * +--------------------------------------+-----------------+----------------+-----------------+-------------+
     * | (timestamp)                          |        (amount) |       (cashIn) |       (cashOut) | (totalCash) |
     * +--------------------------------------+-----------------+----------------+-----------------+-------------+
     *
     */
    buildSales() {
        let tableRows = [];
        let salesList = document.getElementById('salesList');

        this.dbMngt.getSales().then(saleItems => {
            let totalCashIn = 0,
                totalCashOut = 0,
                totalCash = 0,
                totalCC = 0,
                totalCountCash = 0,
                totalCountCC = 0,
                saleInitialCash = document.getElementById('saleInitialCash').value,
                saleTotalCashIn = document.getElementById('saleTotalCashIn'),
                saleTotalCashOut = document.getElementById('saleTotalCashOut'),
                saleTotalCash = document.getElementById('saleTotalCash'),
                saleTotalCC = document.getElementById('saleTotalCC'),
                saleTotal = document.getElementById('saleTotal'),
                saleCountTotalCash = document.getElementById('saleCountTotalCash'),
                saleCountTotalCC = document.getElementById('saleCountTotalCC'),
                saleCountTotal = document.getElementById('saleCountTotal'),
                saleCurrentCash = document.getElementById('saleCurrentCash');

            if(saleInitialCash=='') {
                saleInitialCash = 0;
            }
            else {
                saleInitialCash = parseFloat(saleInitialCash);
            }

            // stock has been retrieved, do sort
            saleItems.sort((a, b) => {
                // sort by date
                if(a.timestamp > b.timestamp) {
                    return 1;
                }
                else if(a.timestamp < b.timestamp) {
                    return -1;
                }
                else {
                    return 0;
                }
            });

            // build table content
            for(const saleItem of saleItems) {
                let tableRow = [],
                    payModeIcon = '';

                tableRow.push('<tr>');

                // date
                let saleDateFmt = `${lead0(saleItem.timestamp.getFullYear(), 4)}-${lead0(saleItem.timestamp.getMonth()+1, 2)}-${lead0(saleItem.timestamp.getDate(), 2)} ${lead0(saleItem.timestamp.getHours(), 2)}:${lead0(saleItem.timestamp.getMinutes(), 2)}`;
                tableRow.push('<td>');
                tableRow.push(`<span class='fa fa-trash merch-delete-item' data-sale-key='${saleItem.key}' data-sale-date='${saleDateFmt}' data-sale-amount='${saleItem.amount}'>&nbsp;</span>`);
                tableRow.push(saleDateFmt);
                tableRow.push('</td>');

                // payment mode
                if(saleItem.paymentMode==constants.PAYMODE_CASH) {
                    payModeIcon = 'fa-money-bill-alt';
                    totalCash += saleItem.amount;
                    totalCountCash += 1;
                }
                else {
                    payModeIcon = 'fa-credit-card ';
                    totalCC += saleItem.amount;
                    totalCountCC += 1;
                }
                
                // amount
                tableRow.push('<td class="text-right">');
                tableRow.push(`${saleItem.amount.toFixed(2)}`);
                tableRow.push(`<span class='fa ${payModeIcon} merch-info-sale' data-sale-key='${saleItem.key}'>&nbsp;</span>`);
                tableRow.push('</td>');

                // cash in
                tableRow.push('<td class="text-right">');
                if(saleItem.paymentMode==constants.PAYMODE_CASH) {
                    totalCashIn += saleItem.cashIn;
                    tableRow.push(`${saleItem.cashIn.toFixed(2)}`);
                }
                tableRow.push('</td>');

                // cash out
                tableRow.push('<td class="text-right">');
                if(saleItem.paymentMode==constants.PAYMODE_CASH) {
                    totalCashOut += saleItem.cashOut;
                    tableRow.push(`${saleItem.cashOut.toFixed(2)}`);
                }
                tableRow.push('</td>');

                // total cash
                tableRow.push('<td class="text-right">');
                if(saleItem.paymentMode==constants.PAYMODE_CASH) {
                    let total = saleInitialCash +totalCash;
                    tableRow.push(`${total.toFixed(2)}`);
                }
                tableRow.push('</td>');

                tableRow.push('</tr>');

                tableRows.push(tableRow.join(''));
            }

            tableRows.reverse();

            // set table content
            salesList.innerHTML = tableRows.join('');
            saleTotalCashIn.innerHTML = totalCashIn.toFixed(2);
            saleTotalCashOut.innerHTML = totalCashOut.toFixed(2);
            saleTotalCash.innerHTML = totalCash.toFixed(2);
            saleTotalCC.innerHTML = totalCC.toFixed(2);
            saleTotal.innerHTML = (totalCC + totalCash).toFixed(2);
            saleCurrentCash.innerHTML = (saleInitialCash + totalCash).toFixed(2);

            saleCountTotalCash.innerHTML = `${totalCountCash}`;
            saleCountTotalCC.innerHTML = `${totalCountCC}`;
            saleCountTotal.innerHTML = `${totalCountCash + totalCountCC}`;

            let deleteBtns = salesList.querySelectorAll('.merch-delete-item[data-sale-key]');
            for(const deleteBtn of deleteBtns) {
                deleteBtn.addEventListener('click', (event) => {
                    let sale = event.target,
                        saleKey = parseInt(sale.attributes['data-sale-key'].value),
                        saleAmount = parseFloat(sale.attributes['data-sale-amount'].value),
                        saleDate = sale.attributes['data-sale-date'].value;

                    if(confirm(`Delete sale?\n - Date: ${saleDate}\n - Amount: ${saleAmount.toFixed(2)}€`)) {
                        let trItem = sale.closest("tr"),
                            remove = this.dbMngt.removeSalesItem(saleKey);

                        remove.then(() => {
                            this.buildSales();
                            this.buildBasket(true);
                        });
                    }
                });
            }
            let infoBtns = salesList.querySelectorAll('.merch-info-sale[data-sale-key]');
            for(const infoBtn of infoBtns) {
                infoBtn.addEventListener('click', (event) => {
                    let sale = event.target,
                        saleKey = parseInt(sale.attributes['data-sale-key'].value);

                    let saleNfo = this.dbMngt.getSale(saleKey);
                    saleNfo.then((saleData) => {
                        let saleDetail = document.getElementById('saleDetail'),
                            saleDetailItems = document.getElementById('saleDetailItems'),
                            saleDetailDate = document.getElementById('saleDetailDate'),
                            saleDetailPaymentMode = document.getElementById('saleDetailPaymentMode'),
                            saleDetailAmount = document.getElementById('saleDetailAmount'),
                            tableContent = [];

                        saleDetailDate.innerHTML = `${lead0(saleData.timestamp.getFullYear(), 4)}-${lead0(saleData.timestamp.getMonth()+1, 2)}-${lead0(saleData.timestamp.getDate(), 2)} ${lead0(saleData.timestamp.getHours(), 2)}:${lead0(saleData.timestamp.getMinutes(), 2)}`;
                        saleDetailAmount.innerHTML = saleData.amount.toFixed(2);
                        if(saleData.paymentMode == constants.PAYMODE_CASH) {
                            saleDetailPaymentMode.innerHTML = 'Cash';
                        }
                        else {
                            saleDetailPaymentMode.innerHTML = 'Credit Card';
                        }

                        for(const detail of saleData.details) {
                            let isGift='',
                                iconHtml='';
                            if(detail.isGift) {
                                isGift=`<span class='fa fa-gift merch-gift'></span>`;
                            }

                            if(/\.svg$/.test(detail.icon)) {
                                iconHtml=`<span class='merch-item' style='background-color: ${detail.bgcolor}; color: ${detail.fgcolor}; background-image: url("./svg/${detail.icon}")'>&nbsp;</span>`;
                            }
                            else {
                                iconHtml=`<span class='merch-item fa ${detail.icon}' style='background-color: ${detail.bgcolor}; color: ${detail.fgcolor};'>&nbsp;</span>`;
                            }

                            tableContent.push(`<tr>
                                                <td>
                                                 ${iconHtml}<span>${detail.label}</span>
                                                </td>
                                                <td class='text-right'>
                                                 ${isGift}
                                                  <span class='merch-amount'>${detail.amount.toFixed(2)}</span>
                                                </td>
                                               </tr>`);
                        }

                        saleDetailItems.innerHTML = tableContent.join('');
                        saleDetail.classList.remove('hide');
                    });
                });
            }
        });
    }

    /**
     * Build basket page
     * 
     */
    buildBasket(forceBuild) {
        if(this.basketBuilt && (forceBuild == false)) {
            // basket already built, and not asked to rebuild it => exit
            // (rebuild page = loose current basket, so buid page only if needed)
            return;
        }

        let stockList = document.getElementById('stockList'),
            paymentModeCC = document.getElementById('paymentModeCC'),
            paymentModeCash = document.getElementById('paymentModeCash'),
            paymentCashAmount = document.getElementById('paymentCashAmount'),
            paymentBtnCashValidate = document.getElementById('paymentBtnCashValidate'),
            paymentBtnValidate = document.getElementById('paymentBtnValidate'),
            paymentBtnCancel = document.getElementById('paymentBtnCancel');

        if(this.basketBuilt==false) {
            // page not yet built - this part is not rebuild even if forceBuild=true 
            // (manage event on main page elements)
            paymentModeCC.addEventListener('change', (event) => {
                // update basket when changing payment mode (price can be not the same)
                this.updateBasket();
            });
            paymentModeCash.addEventListener('change', (event) => {
                // update basket when changing payment mode (price can be not the same)
                this.updateBasket();
            });
            paymentCashAmount.addEventListener('input', (event) => {
                // update basket when changing payment mode (price can be not the same)
                this.updateBasketAmountToGiveBack();
            });
            paymentBtnCancel.addEventListener('click', (event) => {
                // cancel basket
                if(confirm("Cancel current basket?")) {
                    let basketItems = document.getElementById('basketItems'),
                        paymentCashAmount = document.getElementById('paymentCashAmount');
                    this.basketAmountCash = 0.00;
                    this.basketAmountCc = 0.00;

                    for(const basketItem of this.basketItems) {
                        let item = basketProducts.querySelector(`div[data-ref='${basketItem.ref}']`);
                        this.updateProductQty(item, 1);
                    }

                    this.basketItems = [];
                    basketItems.innerHTML = '';
                    paymentCashAmount.value = "";

                    this.updateBasket();
                }
            });
            paymentBtnValidate.addEventListener('click', (event) => {
                // payment 
                // - create sale (+update stock)
                // - reset basket
                let saleDate = new Date(),
                    sale = {timestamp: saleDate,
                            amount: 0,
                            cashIn: 0,
                            cashOut: 0,
                            paymentMode: this.basketPaymentMode,
                            details: []
                            };

                if(this.basketPaymentMode == constants.PAYMODE_CC) {
                    sale.amount = this.basketAmountCc;
                }
                else {
                    sale.amount = this.basketAmountCash;
                    sale.cashIn = this.basketAmountCashIn;
                    sale.cashOut = this.basketAmountCashOut;
                }

                for(const basketItem of this.basketItems) {
                    let item = basketProducts.querySelector(`div[data-ref='${basketItem.ref}']`),
                        saleDetail = {ref: basketItem.ref,
                                      amount: 0,
                                      isGift: basketItem.isGift,
                                      label: basketItem.label,
                                      icon: basketItem.icon,
                                      bgcolor: basketItem.bgcolor,
                                      fgcolor: basketItem.fgcolor
                                    };
                    if(basketItem.isGift == false) {
                        if(this.basketPaymentMode == constants.PAYMODE_CC) {
                            saleDetail.amount = basketItem.priceCC;
                        }
                        else {
                            saleDetail.amount = basketItem.priceCash;
                        }
                    }
                    sale.details.push(saleDetail);
                }
                this.dbMngt.insertSalesItem(sale);

                this.basketAmountCash = 0.00;
                this.basketAmountCc = 0.00;
                this.basketItems = [];
                basketItems.innerHTML = '';
                paymentCashAmount.value = "";

                this.updateBasket();
            });
            paymentBtnCashValidate.addEventListener('click', (event) => {
                // payment cash in one click
                // - update paid amount with basket amount
                // - validate basket
                let paymentCashAmount = document.getElementById('paymentCashAmount'),
                    paymentBtnValidate = document.getElementById('paymentBtnValidate');

                paymentCashAmount.value = this.basketAmountCash;
                this.updateBasketAmountToGiveBack();
                paymentBtnValidate.dispatchEvent(new Event("click"));
            });
        }

        this.dbMngt.getStock().then(stockItems => {
            // stock has been retrieved, do sort
            stockItems.sort((a, b) => {
                // sort by type, group, order
                if(a.type > b.type) {
                    return 1;
                }
                else if(a.type < b.type) {
                    return -1;
                }
                else {
                    if(a.group > b.group) {
                        return 1;
                    }
                    else if(a.group < b.group) {
                        return -1;
                    }
                    else {
                        if(a.order > b.order) {
                            return 1;
                        }
                        else if(a.order < b.order) {
                            return -1;
                        }
                        else {
                            return 0;
                        }
                    }
                }
            });

            let barContent = [],
                pageContent = [],
                typeContent = [],
                groupContent = [],
                currentType = undefined,
                currentGroup = undefined,
                isFirstType = true,
                basketProducts = document.getElementById('basketProducts'),
                basketProductsBar = document.getElementById('basketProductsBar');

            // build table content
            for(const stockItem of stockItems) {
                let classAlert = '',
                    disabled = '',
                    asSvgIcon='',
                    asFaIcon='';

                if(stockItem.type != currentType) {
                    let classActive='merch-page-notactive';

                    if(isFirstType) {
                        classActive='merch-page-active';
                        isFirstType = false;
                    }

                    if(groupContent.length > 0) {
                        groupContent.push('</div>');
                        groupContent.push('</div>');
                        typeContent.push(groupContent.join(''));
                    }

                    if(typeContent.length > 0) {
                        typeContent.push('</div>');
                        pageContent.push(typeContent.join(''));
                    }

                    typeContent = [];
                    groupContent = [];
                    currentType = stockItem.type;
                    currentGroup = undefined;

                    typeContent.push(`<div id='basketProduct-${stockItem.type}' class='${classActive}'>`);
                    barContent.push(`<li class='merch-basket-type'><a class='fa ${stockItem.typeIcon} ${classActive}' data-page='basketProduct-${stockItem.type}'></a></li>`);
                }

                if(stockItem.group != currentGroup) {
                    if(groupContent.length > 0) {
                        groupContent.push('</div>');
                        groupContent.push('</div>');
                    }

                    currentGroup = stockItem.group;
                    groupContent.push(`<div class='merch-basket-group'>`);
                    groupContent.push(`<div class='merch-basket-group-title'><h3>${stockItem.group.replaceAll('\\\\', "<br>")}</h3></div>`);
                    groupContent.push(`<div class='merch-basket-group-items'>`);
                }

                if(stockItem.currentQty == 0) {
                    classAlert = " merch-is-empty";
                    disabled = 'disabled';
                }
                else if(stockItem.currentQty <= SETUP_STOCK_LOW_LIMIT_ALERT) {
                    classAlert=" merch-is-low";
                }

                groupContent.push(`<div class='merch-basket-item'>`);

                if(/\.svg$/.test(stockItem.icon)) {
                    asSvgIcon = `background-image: url("./svg/${stockItem.icon}");`;
                }
                else {
                    asFaIcon = `fa ${stockItem.icon}`;
                }
                groupContent.push(`<div class='btn-add ${classAlert}' ${disabled} style='background-color: ${stockItem.bgcolor}; color: ${stockItem.fgcolor}; ${asSvgIcon}' data-ref="${stockItem.ref}" data-label="${stockItem.label}" data-qty="${stockItem.currentQty}" data-price-cc="${stockItem.priceCC}" data-price-cash="${stockItem.priceCash}" data-style-bgcolor="${stockItem.bgcolor}" data-style-fgcolor="${stockItem.fgcolor}" data-style-icon="${stockItem.icon}">`);
                if(asFaIcon!='') {
                    groupContent.push(`<div class="${asFaIcon}"></div>`);
                }
                groupContent.push(`</div></div>`);
            }

            if(groupContent.length > 0) {
                groupContent.push('</div>');
                groupContent.push('</div>');
                typeContent.push(groupContent.join(''));
            }

            if(typeContent.length > 0) {
                typeContent.push('</div>');
                pageContent.push(typeContent.join(''));
            }

            basketProductsBar.innerHTML = "<ul>" + barContent.join('') + "</ul>";
            basketProducts.innerHTML = pageContent.join('');

            // get pages linked to navigation bar
            let pages = basketProductsBar.querySelectorAll('a[data-page]');

            for(const page of pages) {
                // get linked page to basket button
                let linkedPageId = page.attributes['data-page'].value;
                let linkedPage = document.getElementById(linkedPageId);

                if(page.classList.contains('merch-page-active')) {
                    this.basketPageId = linkedPageId;
                }

                page.addEventListener('click', (event) => {
                    let newActivePageId = event.target.attributes['data-page'].value,
                        basketProducts = document.getElementById('basketProducts'),
                        basketProductsBar = document.getElementById('basketProductsBar'),
                        oldCurrentPageBtn = basketProductsBar.querySelectorAll(`a[data-page="${this.basketPageId}"]`)[0],
                        oldCurrentPage = document.getElementById(this.basketPageId),
                        newCurrentPageBtn = basketProductsBar.querySelectorAll(`a[data-page="${newActivePageId}"]`)[0],
                        newCurrentPage = document.getElementById(newActivePageId);

                    newCurrentPage.classList.toggle('merch-page-active');
                    newCurrentPage.classList.toggle('merch-page-notactive');
                    newCurrentPageBtn.classList.toggle('merch-page-active');
                    newCurrentPageBtn.classList.toggle('merch-page-notactive');

                    oldCurrentPage.classList.toggle('merch-page-active');
                    oldCurrentPage.classList.toggle('merch-page-notactive');
                    oldCurrentPageBtn.classList.toggle('merch-page-active');
                    oldCurrentPageBtn.classList.toggle('merch-page-notactive');

                    this.basketPageId = newActivePageId;
                });
            }

            // add events to products, when clicked
            let basketProductItems = basketProducts.querySelectorAll('div[data-ref]');
            for(const basketProduct of basketProductItems) {
                basketProduct.addEventListener('click', (event) => {
                    let basketItems = document.getElementById('basketItems'),
                        item = event.currentTarget,
                        itemRef = item.attributes['data-ref'].value,
                        itemLabel = item.attributes['data-label'].value,
                        itemPriceCC = parseFloat(item.attributes['data-price-cc'].value),
                        itemPriceCash = parseFloat(item.attributes['data-price-cash'].value),
                        itemQty = parseInt(item.attributes['data-qty'].value),
                        itemBgColor = item.attributes['data-style-bgcolor'].value,
                        itemFgColor = item.attributes['data-style-fgcolor'].value,
                        itemIcon = item.attributes['data-style-icon'].value,
                        asFaIcon = '',
                        asSvgIcon = '';

                    if(itemQty==0) {
                        // normally can't occurs...
                        return;
                    }

                    this.basketEntryId += 1;
                    this.basketAmountCash += itemPriceCash;
                    this.basketAmountCc += itemPriceCC;
                    this.basketItems.push({ref: itemRef,
                                           label: itemLabel,
                                           priceCC: itemPriceCC,
                                           priceCash: itemPriceCash,
                                           isGift: false,
                                           basketEntryId: this.basketEntryId,
                                           bgcolor: itemBgColor,
                                           fgcolor: itemFgColor,
                                           icon: itemIcon
                                           });

                    let trItem = document.createElement('tr');
                    if(/\.svg$/.test(itemIcon)) {
                        asSvgIcon = `background-image: url("./svg/${itemIcon}");`;
                    }
                    else {
                        asFaIcon = `fa ${itemIcon}`;
                    }

                    trItem.innerHTML = `<td>
                                            <span class='fa fa-trash merch-delete-item' data-basket-entry='${this.basketEntryId}'>&nbsp;</span><span class='merch-item ${asFaIcon}' style='background-color: ${itemBgColor}; color: ${itemFgColor}; ${asSvgIcon}'>&nbsp;</span><span>${itemLabel}</span>
                                        </td>
                                        <td class='text-right'>
                                            <input type='checkbox' id='basketGift${this.basketEntryId}' class='hide' data-basket-entry='${this.basketEntryId}'>
                                            <label for='basketGift${this.basketEntryId}' class='fa fa-gift merch-gift'></label>
                                            <span class='merch-amount' data-basket-entry='${this.basketEntryId}'></span>
                                        </td>`;
                    basketItems.prepend(trItem);

                    this.updateProductQty(item, -1);

                    let deleteBtn = trItem.querySelector('.fa-trash[data-basket-entry]'),
                        giftBtn = trItem.querySelector('[type="checkbox"][data-basket-entry]');

                    deleteBtn.addEventListener('click', (event) => {
                        let basketEntryId = event.target.attributes['data-basket-entry'].value,
                            trItem = event.target.closest("tr");

                        if(trItem) {
                            trItem.remove();

                            for(let index = 0; index < this.basketItems.length; index++) {
                                let basketItem = this.basketItems[index];

                                if(basketItem.basketEntryId == basketEntryId) {
                                    let item = basketProducts.querySelector(`div[data-ref='${basketItem.ref}']`);
                                    this.basketAmountCash -= basketItem.priceCash;
                                    this.basketAmountCc -= basketItem.priceCC;

                                    this.basketAmountCash = Math.round(this.basketAmountCash * 100) / 100;
                                    this.basketAmountCc = Math.round(this.basketAmountCc * 100) / 100;

                                    this.basketItems.splice(index, 1);

                                    this.updateProductQty(item, 1);
                                    break;
                                }
                            }

                            this.updateBasket();
                        }
                    });

                    giftBtn.addEventListener('click', (event) => {
                        let basketEntryId = event.target.attributes['data-basket-entry'].value,
                            basketEntryInput = document.getElementById(`basketGift${basketEntryId}`);

                        for(let index = 0; index < this.basketItems.length; index++) {
                            let basketItem = this.basketItems[index];

                            if(basketItem.basketEntryId == basketEntryId) {
                                this.basketItems[index].isGift = basketEntryInput.checked;
                                if(this.basketItems[index].isGift) {
                                    this.basketAmountCash -= basketItem.priceCash;
                                    this.basketAmountCc -= basketItem.priceCC;
                                }
                                else {
                                    this.basketAmountCash += basketItem.priceCash;
                                    this.basketAmountCc += basketItem.priceCC;
                                }
                                break;
                            }
                        }

                        this.updateBasket();
                    });

                    this.updateBasket();
                });
            }

            this.updateBasket();
            this.basketBuilt = true;
        });
    }

    /**
     * Update basket content: item list, prices, total, ...
     */
    updateBasket() {
        let basketItems = document.getElementById('basketItems'),
            paymentModeCC = document.getElementById('paymentModeCC'),
            paymentTotalAmount = document.getElementById('paymentTotalAmount');

        if(paymentModeCC.checked) {
            paymentTotalAmount.innerHTML = this.basketAmountCc.toFixed(2);
            this.basketPaymentMode = constants.PAYMODE_CC;
        }
        else {
            paymentTotalAmount.innerHTML = this.basketAmountCash.toFixed(2);
            this.basketPaymentMode = constants.PAYMODE_CASH;
        }
        this.updateBasketAmountToGiveBack();

        for(const basketItem of this.basketItems) {
            let domItem = basketItems.querySelector(`.merch-amount[data-basket-entry='${basketItem.basketEntryId}']`);
            if(domItem) {
                if(basketItem.isGift) {
                    domItem.innerHTML = "0.00";
                }
                else if(this.basketPaymentMode == constants.PAYMODE_CC) {
                    domItem.innerHTML = basketItem.priceCC.toFixed(2);
                }
                else {
                    domItem.innerHTML = basketItem.priceCash.toFixed(2);
                }
            }
        }
    }

    /**
     * Update basket amount to give back
     */
    updateBasketAmountToGiveBack() {
        let paymentCashAmount = document.getElementById('paymentCashAmount').value,
            paymentCashAmountToGiveBack = document.getElementById('paymentCashAmountToGiveBack'),
            paymentBtnCashValidate = document.getElementById('paymentBtnCashValidate'),
            paymentBtnCancel = document.getElementById('paymentBtnCancel'),
            paymentBtnValidate = document.getElementById('paymentBtnValidate');

        if(paymentCashAmount=='') {
            this.basketAmountCashIn = 0.0;
        }
        else {
            this.basketAmountCashIn = parseFloat(paymentCashAmount);
        }

        if(this.basketPaymentMode == constants.PAYMODE_CC) {
            this.basketAmountCashOut = 0.00;
            paymentBtnValidate.disabled = false;
            paymentBtnCashValidate.disabled = true;
        }
        else {
            this.basketAmountCashOut = this.basketAmountCashIn - this.basketAmountCash;
            paymentBtnValidate.disabled = (this.basketAmountCashOut < 0);
            paymentBtnCashValidate.disabled = false;
        }
        if(this.basketItems.length==0) {
            paymentBtnValidate.disabled = true;
            paymentBtnCancel.disabled = true;
            paymentBtnCashValidate.disabled = true;
        }
        else {
            paymentBtnCancel.disabled = false;
        }
        paymentCashAmountToGiveBack.innerHTML = this.basketAmountCashOut.toFixed(2);
    }

    /**
     * update quantity for given product (dom element of basket product)
     */
    updateProductQty(item, updateQuantity) {
        let itemQty = parseInt(item.attributes['data-qty'].value);

        itemQty += updateQuantity;
        if (itemQty == 0) {
            item.disabled = true;
            item.classList.remove("merch-is-low");
            item.classList.add("merch-is-empty");
        }
        else if(itemQty <= SETUP_STOCK_LOW_LIMIT_ALERT) {
            item.disabled = false;
            item.classList.add("merch-is-low");
            item.classList.remove("merch-is-empty");
        }
        else {
            item.classList.remove("merch-is-low");
            item.classList.remove("merch-is-empty");
        }
        item.attributes['data-qty'].value = itemQty;
    }
}

/**
 * Page loaded and ready, start to initialise events and build page content 
 */
document.addEventListener("readystatechange", (event) => {
    let dbMngt = new DbMngt(),
        backdropList = document.querySelectorAll('.merch-backdrop');

    dbMngt.addEventListener('ready', () => {
        // database ready
        let mainNavBar = new NavBar('mainNavBar'),
            mainPages = new Pages(dbMngt),
            inputSaveFile = document.getElementById('saveStockFromFile'),
            inputLoadFile = document.getElementById('loadStockFromFile'),
            inputSetupStockLowLimit = document.getElementById('setupStockLowLimit'),
            inputSetupExportFilename = document.getElementById('setupExportFilename');    

        mainNavBar.setCallbackPage('pageStock', () => { mainPages.buildStock(); });
        mainNavBar.setCallbackPage('pageSales', () => { mainPages.buildSales(); });
        mainNavBar.setCallbackPage('pageBasket', () => { mainPages.buildBasket(UPDATE_BASKET_PAGE); });

        if(inputLoadFile) {
            inputLoadFile.addEventListener('change', (event) => {
                let loadedContent = dbMngt.loadStockFromFile(inputLoadFile.files[0]);
                loadedContent.then(content => {
                    mainPages.buildStock();
                    mainPages.buildSales();
                    mainPages.buildBasket(true);
                });
            });
        }
        if(inputSaveFile) {
            inputSaveFile.addEventListener('click', (event) => {
               dbMngt.saveStockAndSalesFile();
            });
        }
        if(inputSetupStockLowLimit) {
            let setupStockLowLimit = localStorage.getItem(constants.SETUP_STOCK_LOW_LIMIT_ALERT);
            if(setupStockLowLimit) {
                SETUP_STOCK_LOW_LIMIT_ALERT = parseInt(setupStockLowLimit);
            }
            inputSetupStockLowLimit.value = SETUP_STOCK_LOW_LIMIT_ALERT;
            
            inputSetupStockLowLimit.addEventListener('change', (event) => {
                localStorage.setItem(constants.SETUP_STOCK_LOW_LIMIT_ALERT, inputSetupStockLowLimit.value);
                SETUP_STOCK_LOW_LIMIT_ALERT = parseInt(inputSetupStockLowLimit.value);
                UPDATE_BASKET_PAGE = true;
            });
        }

        if(inputSetupExportFilename) {
            let setupExportFilename = localStorage.getItem(constants.SETUP_EXPORT_FILE_NAME);
            if(setupExportFilename) {
                SETUP_EXPORT_FILE_NAME = setupExportFilename.replace(/\.xlsx$/, "");
            }
            inputSetupExportFilename.value = SETUP_EXPORT_FILE_NAME;

            inputSetupExportFilename.addEventListener('change', (event) => {
                localStorage.setItem(constants.SETUP_EXPORT_FILE_NAME, inputSetupExportFilename.value.replace(/\.xlsx$/, ""));
                SETUP_EXPORT_FILE_NAME = inputSetupExportFilename.value.replace(/\.xlsx$/, "")+".xlsx";
            });
        }
       

        mainPages.buildBasket(false);
    });

    for(const backdrop of backdropList) {
        // manage dialog box info
        backdrop.addEventListener('click', (event) => {
            let item = event.target;

            if(item.classList.contains('merch-backdrop') == false) {
                item = item.closest('.merch-backdrop');
            }
            item.classList.add('hide');
        });
    }

});


export { DbMngt };
